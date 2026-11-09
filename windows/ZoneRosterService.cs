// Windows service host for Zone Roster. It starts Node, restarts it if it exits, and hands it the
// credentials stored encrypted with DPAPI.
//
//   ZoneRosterService.exe                                 run under the Service Control Manager
//   ZoneRosterService.exe --console [dataDir]             run in a console for troubleshooting; Enter stops it
//   ZoneRosterService.exe --store-acs-credentials dataDir store the username and password given on stdin
//
// Expects node.exe and app\src\index.js beside the executable. Written for the C# 5 compiler that
// ships with Windows, so the project needs no SDK or third-party service wrapper.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.ServiceProcess;
using System.Text;
using System.Threading;

namespace ZoneRoster
{
    sealed class Host
    {
        const long MaxLogBytes = 5 * 1024 * 1024;
        const int MaxRestartDelayMs = 60000;
        const int StopTimeoutMs = 10000;

        readonly string installDir = AppDomain.CurrentDomain.BaseDirectory;
        readonly string dataDir;
        readonly string logFile;
        readonly bool echo;
        readonly object logLock = new object();
        readonly object childLock = new object();
        readonly ManualResetEvent stopping = new ManualResetEvent(false);
        Thread supervisor;
        Process child;

        public Host(string dataDir, bool echo)
        {
            this.dataDir = dataDir;
            this.echo = echo;
            logFile = Path.Combine(dataDir, "logs", "service.log");
        }

        public static string DefaultDataDir
        {
            get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "ZoneRoster"); }
        }

        public void Start()
        {
            Directory.CreateDirectory(Path.GetDirectoryName(logFile));
            supervisor = new Thread(Supervise) { IsBackground = true, Name = "supervisor" };
            supervisor.Start();
        }

        public void Stop()
        {
            stopping.Set();
            Process running;
            lock (childLock) running = child;
            if (running != null) RequestExit(running);
            supervisor.Join(StopTimeoutMs + 5000);
        }

        // Windows has no SIGTERM. Closing stdin asks Node to save its state and exit.
        void RequestExit(Process process)
        {
            try
            {
                process.StandardInput.Close();
                if (!process.WaitForExit(StopTimeoutMs))
                {
                    Note("Node did not stop in time; ending it");
                    process.Kill();
                }
            }
            catch (InvalidOperationException) { } // already exited
            catch (System.ComponentModel.Win32Exception) { } // exiting
        }

        void Supervise()
        {
            int delayMs = 1000;
            while (!stopping.WaitOne(0))
            {
                DateTime started = DateTime.UtcNow;
                int code = RunNode();
                if (stopping.WaitOne(0)) break;
                if ((DateTime.UtcNow - started).TotalSeconds > 60) delayMs = 1000;
                Note(string.Format("Node exited with code {0}; restarting in {1} s", code, delayMs / 1000));
                stopping.WaitOne(delayMs);
                delayMs = Math.Min(delayMs * 2, MaxRestartDelayMs);
            }
            Note("Stopped");
        }

        int RunNode()
        {
            var info = new ProcessStartInfo(Path.Combine(installDir, "node.exe"))
            {
                Arguments = string.Format("\"{0}\" run --config \"{1}\" --stop-on-stdin-close",
                    Path.Combine(installDir, "app", "src", "index.js"), Path.Combine(dataDir, "config.json")),
                WorkingDirectory = dataDir,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8,
            };
            // How the Setup view stores a new ACS sign-in.
            info.EnvironmentVariables["ZONE_ROSTER_SECRET_TOOL"] = Process.GetCurrentProcess().MainModule.FileName;
            info.EnvironmentVariables["ZONE_ROSTER_DATA_DIR"] = dataDir;
            LoadSecrets(info);

            try
            {
                using (var process = new Process { StartInfo = info })
                {
                    process.OutputDataReceived += (s, e) => { if (e.Data != null) Write(e.Data); };
                    process.ErrorDataReceived += (s, e) => { if (e.Data != null) Write(e.Data); };
                    process.Start();
                    process.BeginOutputReadLine();
                    process.BeginErrorReadLine();
                    lock (childLock) child = process;
                    if (stopping.WaitOne(0)) RequestExit(process); // Stop() ran before child was set
                    process.WaitForExit();
                    lock (childLock) child = null;
                    return process.ExitCode;
                }
            }
            catch (System.ComponentModel.Win32Exception e)
            {
                Note("Could not start Node: " + e.Message);
                return -1;
            }
        }

        // Failures are logged rather than thrown: Node then reports the missing credentials itself.
        void LoadSecrets(ProcessStartInfo info)
        {
            try
            {
                foreach (var secret in Secrets.Read(Secrets.FileIn(dataDir))) info.EnvironmentVariables[secret.Key] = secret.Value;
            }
            catch (IOException e) { Note("Could not read credentials: " + e.Message); }
            catch (UnauthorizedAccessException e) { Note("Could not read credentials: " + e.Message); }
            catch (CryptographicException e) { Note("Could not decrypt credentials: " + e.Message); }
        }

        void Note(string message)
        {
            Write(DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ") + " [service] " + message);
        }

        void Write(string line)
        {
            if (echo) Console.WriteLine(line);
            lock (logLock)
            {
                try
                {
                    var log = new FileInfo(logFile);
                    if (log.Exists && log.Length > MaxLogBytes)
                    {
                        File.Copy(logFile, logFile + ".1", true);
                        File.Delete(logFile);
                    }
                    File.AppendAllText(logFile, line + Environment.NewLine);
                }
                catch (IOException) { } // logging must never take the service down
                catch (UnauthorizedAccessException) { }
            }
        }
    }

    sealed class Service : ServiceBase
    {
        readonly Host host = new Host(Host.DefaultDataDir, false);

        public Service()
        {
            ServiceName = "ZoneRoster";
            CanStop = true;
            CanShutdown = true;
        }

        protected override void OnStart(string[] args) { host.Start(); }
        protected override void OnStop() { host.Stop(); }
        protected override void OnShutdown() { host.Stop(); }
    }

    static class Program
    {
        // The details never appear in the output: Node reports only that storing failed.
        static int StoreAcsCredentials(string dataDir)
        {
            try
            {
                using (var input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false)))
                {
                    string username = input.ReadLine(), password = input.ReadLine();
                    if (string.IsNullOrEmpty(username) || string.IsNullOrEmpty(password)) return 2;
                    Secrets.Merge(Secrets.FileIn(dataDir), new Dictionary<string, string> { { "ACS_USERNAME", username }, { "ACS_PASSWORD", password } });
                }
                return 0;
            }
            catch (IOException) { return 1; }
            catch (UnauthorizedAccessException) { return 1; }
            catch (CryptographicException) { return 1; }
        }

        static int Main(string[] args)
        {
            if (args.Length == 2 && args[0] == "--store-acs-credentials") return StoreAcsCredentials(Path.GetFullPath(args[1]));
            if (args.Length > 0 && args[0] == "--console")
            {
                var host = new Host(args.Length > 1 ? Path.GetFullPath(args[1]) : Host.DefaultDataDir, true);
                host.Start();
                Console.WriteLine("Zone Roster is running. Press Enter to stop.");
                Console.ReadLine();
                host.Stop();
                return 0;
            }
            ServiceBase.Run(new Service());
            return 0;
        }
    }
}
