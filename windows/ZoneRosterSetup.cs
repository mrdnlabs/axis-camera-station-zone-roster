// Zone Roster setup: installs, upgrades or removes the Windows service and tray icon. The program files are
// embedded by Build.ps1, including Node.js, so the target machine needs nothing else. The manifest makes
// Windows ask for administrator approval when it starts.
//
//   ZoneRosterSetup.exe              choose what to do
//   ZoneRosterSetup.exe /uninstall   open with Uninstall selected (used by Windows' Installed apps list)
//
// Written for the C# 5 compiler that ships with Windows.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net;
using System.Net.NetworkInformation;
using System.Reflection;
using System.Security.AccessControl;
using System.Security.Principal;
using System.ServiceProcess;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

namespace ZoneRoster
{
    sealed class SetupException : Exception { public SetupException(string message) : base(message) { } }

    sealed class Installer
    {
        const string ServiceName = "ZoneRoster";
        const string ServiceAccount = @"NT SERVICE\ZoneRoster";
        const string RunKey = @"SOFTWARE\Microsoft\Windows\CurrentVersion\Run";
        const string UninstallKey = @"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\ZoneRoster";
        const string TrayValue = "ZoneRosterTray";
        const string ExampleConfig = "config.example.json";
        const int PortWaitSeconds = 180;
        const string System = "*S-1-5-18", Admins = "*S-1-5-32-544", Users = "*S-1-5-32-545";

        // Full paths, because an elevated program must never run a same-named file planted beside it.
        static readonly string Sc = Path.Combine(Environment.SystemDirectory, "sc.exe");
        static readonly string Icacls = Path.Combine(Environment.SystemDirectory, "icacls.exe");
        static readonly string Cmd = Path.Combine(Environment.SystemDirectory, "cmd.exe");
        static readonly string Ping = Path.Combine(Environment.SystemDirectory, "ping.exe");
        public static readonly string Explorer = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "explorer.exe");

        public static readonly string InstallDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "ZoneRoster");
        static readonly string DataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "ZoneRoster");
        static readonly string ConfigFile = Path.Combine(DataDir, "config.json");
        static readonly string SetupExe = Path.Combine(InstallDir, "ZoneRosterSetup.exe");

        readonly Action<string> log;
        public Installer(Action<string> log) { this.log = log; }

        public static bool IsInstalled { get { return FindService() != null; } }

        // True when this program runs from the folder that uninstalling removes, so the folder must go after it exits.
        public static bool RunningFromInstallDir
        {
            get { return string.Equals(Path.GetFullPath(Application.ExecutablePath), SetupExe, StringComparison.OrdinalIgnoreCase); }
        }

        public static string DashboardUrl { get { return "http://127.0.0.1:" + DashboardPort() + "/"; } }

        public void Install(Dictionary<string, string> credentials)
        {
            log("Stopping anything already running");
            StopTray();
            StopService();
            WaitForPort(DashboardPort());

            log("Copying program files to " + InstallDir);
            Directory.CreateDirectory(InstallDir);
            string appDir = Path.Combine(InstallDir, "app");
            if (Directory.Exists(appDir)) Retry(() => Directory.Delete(appDir, true));
            byte[] exampleConfig = ExtractProgramFiles();
            if (!RunningFromInstallDir) File.Copy(Application.ExecutablePath, SetupExe, true);

            log("Setting up the service");
            if (FindService() == null)
                Run(Sc, "create " + ServiceName + " binPath= \"\\\"" + Path.Combine(InstallDir, "ZoneRosterService.exe") + "\\\"\" start= auto DisplayName= \"Zone Roster\"", "Creating the service");
            Run(Sc, "description " + ServiceName + " \"Shows which AXIS Secure Entry zone people are in, from AXIS Camera Station Pro badge events.\"", "Describing the service");
            Run(Sc, "config " + ServiceName + " obj= \"" + ServiceAccount + "\"", "Setting the service account");
            Run(Sc, "failure " + ServiceName + " reset= 86400 actions= restart/5000/restart/30000/restart/60000", "Setting the recovery options");

            log("Securing the settings and credentials");
            RequireTrustedData();
            PrepareDataFolders();
            if (!File.Exists(ConfigFile)) File.WriteAllBytes(ConfigFile, exampleConfig);
            string secrets = Secrets.FileIn(DataDir);
            if (!File.Exists(secrets)) File.WriteAllBytes(secrets, new byte[0]);
            Run(Icacls, Quote(secrets) + " /inheritance:r /grant:r \"" + System + ":F\" \"" + Admins + ":F\" \"" + ServiceAccount + ":(R,W)\"", "Protecting the credentials file");
            if (credentials.Count > 0) { Secrets.Merge(secrets, credentials); log("Stored the credentials, encrypted"); }

            string tray = Path.Combine(InstallDir, "ZoneRosterTray.exe");
            using (var run = Registry.LocalMachine.CreateSubKey(RunKey)) run.SetValue(TrayValue, Quote(tray));
            using (var entry = Registry.LocalMachine.CreateSubKey(UninstallKey))
            {
                entry.SetValue("DisplayName", "Zone Roster");
                entry.SetValue("UninstallString", Quote(SetupExe) + " /uninstall");
                entry.SetValue("InstallLocation", InstallDir);
                entry.SetValue("DisplayIcon", tray);
                entry.SetValue("NoModify", 1, RegistryValueKind.DWord);
                entry.SetValue("NoRepair", 1, RegistryValueKind.DWord);
            }

            log("Starting the service");
            using (var service = FindService())
            {
                service.Start();
                service.WaitForStatus(ServiceControllerStatus.Running, TimeSpan.FromSeconds(30));
            }
            Process.Start(Explorer, Quote(tray)); // via Explorer, so the tray icon doesn't run as administrator
            log(ReportStatus());
        }

        // Windows can hold the port for a minute or two after the service stops, especially with a dashboard tab open.
        void WaitForPort(int port)
        {
            DateTime deadline = DateTime.UtcNow.AddSeconds(PortWaitSeconds);
            bool told = false;
            while (IPGlobalProperties.GetIPGlobalProperties().GetActiveTcpListeners().Any(e => e.Port == port))
            {
                if (DateTime.UtcNow >= deadline)
                {
                    RestartService(); // leave things as they were, not stopped
                    throw new SetupException("Port " + port + " is still in use. Close the program using it (it may be a copy of Zone Roster started by hand) and try again.");
                }
                if (!told) log("Waiting for Windows to release port " + port + ". This can take a minute or two.");
                told = true;
                Thread.Sleep(1000);
            }
        }

        static void RestartService()
        {
            try { using (var service = FindService()) if (service != null) service.Start(); }
            catch (InvalidOperationException) { } // the error about the port is the one worth reporting
        }

        // Waits for the dashboard and says plainly whether it reached ACS.
        string ReportStatus()
        {
            string url = DashboardUrl + "api/status";
            bool answered = false;
            for (int i = 0; i < 30; i++)
            {
                Thread.Sleep(1000);
                Dictionary<string, object> status = ReadStatus(url);
                if (status == null) continue;
                answered = true;
                if (Equals(Value(status, "signInNeeded"), true))
                    return "Installed. Enter the ACS sign-in in the dashboard's Setup view to start counting.";
                if (Equals(Value(status, "connected"), true)) return "Installed and connected to ACS.";
            }
            return answered ? "Installed, but ACS can't be reached yet. Check the Connection panel in the dashboard's Setup view."
                            : "The service started but the dashboard isn't answering. Check " + Path.Combine(DataDir, "logs", "service.log");
        }

        static object Value(Dictionary<string, object> values, string key)
        {
            object value;
            return values.TryGetValue(key, out value) ? value : null;
        }

        static Dictionary<string, object> ReadStatus(string url)
        {
            var request = (HttpWebRequest)WebRequest.Create(url);
            request.Timeout = 2000;
            request.Proxy = null;
            try
            {
                using (var response = request.GetResponse())
                using (var reader = new StreamReader(response.GetResponseStream()))
                    return new JavaScriptSerializer().DeserializeObject(reader.ReadToEnd()) as Dictionary<string, object>;
            }
            catch (WebException) { return null; }
        }

        public void Uninstall(bool removeData)
        {
            log("Stopping Zone Roster");
            StopTray();
            StopService();
            using (var run = Registry.LocalMachine.OpenSubKey(RunKey, true)) if (run != null) run.DeleteValue(TrayValue, false);
            Registry.LocalMachine.DeleteSubKeyTree(UninstallKey, false);
            if (FindService() != null) Run(Sc, "delete " + ServiceName, "Removing the service");

            log("Removing program files");
            if (Directory.Exists(InstallDir))
            {
                foreach (string dir in Directory.GetDirectories(InstallDir)) Retry(() => Directory.Delete(dir, true));
                foreach (string file in Directory.GetFiles(InstallDir))
                    if (!(RunningFromInstallDir && string.Equals(file, SetupExe, StringComparison.OrdinalIgnoreCase))) Retry(() => File.Delete(file));
                if (!RunningFromInstallDir) Directory.Delete(InstallDir);
            }

            if (removeData)
            {
                if (Directory.Exists(DataDir)) Retry(() => Directory.Delete(DataDir, true));
                log("Zone Roster and its data have been removed.");
            }
            else log("Zone Roster has been removed. Settings, encrypted credentials and badge history (names and card numbers) remain in " + DataDir);
        }

        // A running program can't delete itself, so a short-lived command removes the folder after setup closes.
        public static void RemoveInstallDirAfterExit()
        {
            Process.Start(new ProcessStartInfo(Cmd, "/c " + Ping + " -n 3 127.0.0.1 >nul & rmdir /s /q " + Quote(InstallDir)) { CreateNoWindow = true, UseShellExecute = false });
        }

        static ServiceController FindService()
        {
            return ServiceController.GetServices().FirstOrDefault(s => s.ServiceName == ServiceName);
        }

        static void StopTray()
        {
            foreach (Process p in Process.GetProcessesByName("ZoneRosterTray"))
            {
                p.Kill();
                p.WaitForExit(5000);
            }
        }

        static void StopService()
        {
            using (var service = FindService())
            {
                if (service == null || service.Status == ServiceControllerStatus.Stopped) return;
                if (service.Status != ServiceControllerStatus.StopPending) service.Stop();
                service.WaitForStatus(ServiceControllerStatus.Stopped, TimeSpan.FromSeconds(30));
            }
        }

        // The app's defaults apply if there's no config yet or it doesn't set a port.
        static int DashboardPort()
        {
            try
            {
                var root = new JavaScriptSerializer().DeserializeObject(File.ReadAllText(ConfigFile)) as Dictionary<string, object>;
                var server = root == null ? null : Value(root, "server") as Dictionary<string, object>;
                object port = server == null ? null : Value(server, "port");
                if (port != null) return Convert.ToInt32(port);
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
            catch (ArgumentException) { }
            return 8787;
        }

        // Writes the embedded files to the install folder and returns the example config.
        static byte[] ExtractProgramFiles()
        {
            byte[] exampleConfig = null;
            using (Stream payload = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip"))
            using (var zip = new ZipArchive(payload, ZipArchiveMode.Read))
            {
                foreach (ZipArchiveEntry entry in zip.Entries)
                {
                    if (entry.Name.Length == 0) continue;
                    string relative = entry.FullName.Replace('/', Path.DirectorySeparatorChar);
                    if (relative == ExampleConfig)
                    {
                        using (Stream input = entry.Open())
                        using (var copy = new MemoryStream()) { input.CopyTo(copy); exampleConfig = copy.ToArray(); }
                        continue;
                    }
                    string target = Path.Combine(InstallDir, relative);
                    Directory.CreateDirectory(Path.GetDirectoryName(target));
                    ZipArchiveEntry current = entry;
                    Retry(() =>
                    {
                        using (Stream input = current.Open())
                        using (FileStream output = File.Create(target)) input.CopyTo(output);
                    });
                }
            }
            if (exampleConfig == null) throw new SetupException("This setup program is damaged: it contains no default settings.");
            return exampleConfig;
        }

        // Any user can create folders in ProgramData. A planted config could send the ACS password to another
        // server, so anything already there must belong to an administrator or the service.
        static void RequireTrustedData()
        {
            var trusted = new HashSet<SecurityIdentifier>
            {
                new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
                new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null),
                (SecurityIdentifier)new NTAccount(ServiceAccount).Translate(typeof(SecurityIdentifier)),
                WindowsIdentity.GetCurrent().User,
            };
            foreach (string path in new[] { DataDir, ConfigFile, Secrets.FileIn(DataDir) })
                if ((File.Exists(path) || Directory.Exists(path)) && !OwnedByTrustedAccount(path, trusted))
                    throw new SetupException(path + " was not created by an administrator, so it can't be trusted. Delete it and try again.");
            if (File.Exists(ConfigFile) && ConfigHoldsCredentials(ConfigFile))
                throw new SetupException(ConfigFile + " contains an ACS username or password in plain text. Remove them from that file and try again.");
        }

        public static bool OwnedByTrustedAccount(string path, ICollection<SecurityIdentifier> trusted)
        {
            try
            {
                if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0) return false; // a link could point anywhere
                FileSystemSecurity security = Directory.Exists(path)
                    ? (FileSystemSecurity)Directory.GetAccessControl(path, AccessControlSections.Owner)
                    : File.GetAccessControl(path, AccessControlSections.Owner);
                return trusted.Contains((SecurityIdentifier)security.GetOwner(typeof(SecurityIdentifier)));
            }
            catch (UnauthorizedAccessException) { return false; }
        }

        public static bool ConfigHoldsCredentials(string file)
        {
            var root = new JavaScriptSerializer().DeserializeObject(File.ReadAllText(file)) as Dictionary<string, object>;
            var acs = root == null ? null : Value(root, "acs") as Dictionary<string, object>;
            if (acs == null) return false;
            return !string.IsNullOrEmpty(Value(acs, "username") as string) || !string.IsNullOrEmpty(Value(acs, "password") as string);
        }

        // The config is readable by local users so the tray can find the address; the rest is not.
        static void PrepareDataFolders()
        {
            string[] privateDirs = { Path.Combine(DataDir, "data"), Path.Combine(DataDir, "logs") };
            Directory.CreateDirectory(DataDir);
            foreach (string dir in privateDirs) Directory.CreateDirectory(dir);
            Run(Icacls, Quote(DataDir) + " /inheritance:r /grant:r \"" + System + ":(OI)(CI)F\" \"" + Admins + ":(OI)(CI)F\" \"" + Users + ":(OI)(CI)RX\" \"" + ServiceAccount + ":(OI)(CI)M\"", "Setting permissions on the data folder");
            foreach (string dir in privateDirs)
                Run(Icacls, Quote(dir) + " /inheritance:r /grant:r \"" + System + ":(OI)(CI)F\" \"" + Admins + ":(OI)(CI)F\" \"" + ServiceAccount + ":(OI)(CI)M\"", "Setting permissions on " + dir);
        }

        static string Quote(string path) { return "\"" + path + "\""; }

        static void Run(string exe, string arguments, string what)
        {
            var info = new ProcessStartInfo(exe, arguments) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
            using (Process process = Process.Start(info))
            {
                process.ErrorDataReceived += (s, e) => { };
                process.BeginErrorReadLine();
                string output = process.StandardOutput.ReadToEnd();
                process.WaitForExit();
                if (process.ExitCode != 0) throw new SetupException(what + " failed (exit code " + process.ExitCode + "). " + output.Trim());
            }
        }

        // Files can stay locked for a moment after a process exits.
        static void Retry(Action action)
        {
            for (int attempt = 1; ; attempt++)
            {
                try { action(); return; }
                catch (IOException) { if (attempt == 6) throw; }
                catch (UnauthorizedAccessException) { if (attempt == 6) throw; }
                Thread.Sleep(1000);
            }
        }
    }

    sealed class SetupForm : Form
    {
        const int Left_ = 20, Width_ = 480, LabelWidth = 130;

        readonly RadioButton install = new RadioButton { Text = "Install", AutoSize = true };
        readonly RadioButton uninstall = new RadioButton { Text = "Uninstall", AutoSize = true };
        readonly Panel installOptions = new Panel();
        readonly Panel uninstallOptions = new Panel();
        readonly TextBox acsUser = new TextBox();
        readonly TextBox acsPassword = new TextBox { UseSystemPasswordChar = true };
        readonly CheckBox removeData = new CheckBox { Text = "Also delete settings, stored credentials and badge history", AutoSize = true };
        readonly TextBox output = new TextBox { Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Vertical };
        readonly Button run = new Button();
        readonly Button close = new Button { Text = "Close" };
        readonly Button open = new Button { Text = "Open dashboard", Enabled = false, AutoSize = true };
        readonly Label state = new Label { AutoSize = false };
        bool working, removeFolderOnExit;

        public SetupForm(bool startWithUninstall)
        {
            AutoScaleDimensions = new SizeF(96, 96);
            AutoScaleMode = AutoScaleMode.Dpi;
            Font = SystemFonts.MessageBoxFont;
            Text = "Zone Roster setup";
            Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(Width_ + 2 * Left_, 470);

            Controls.Add(new Label { Text = "Zone Roster", Font = new Font(Font.FontFamily, 14, FontStyle.Bold), Location = new Point(Left_, 14), AutoSize = true });
            state.SetBounds(Left_, 46, Width_, 20);
            Controls.Add(state);

            install.Location = new Point(Left_, 74);
            uninstall.Location = new Point(Left_ + 140, 74);
            Controls.Add(install);
            Controls.Add(uninstall);

            BuildInstallOptions();
            uninstallOptions.SetBounds(Left_, 104, Width_, 130);
            removeData.Location = new Point(0, 4);
            uninstallOptions.Controls.Add(removeData);
            Controls.Add(uninstallOptions);

            output.SetBounds(Left_, 240, Width_, 172);
            Controls.Add(output);

            open.Location = new Point(Left_, 426);
            run.SetBounds(Left_ + Width_ - 190, 426, 95, 30);
            close.SetBounds(Left_ + Width_ - 90, 426, 90, 30);
            Controls.Add(open);
            Controls.Add(run);
            Controls.Add(close);
            AcceptButton = run;

            install.CheckedChanged += (s, e) => ShowChoice();
            uninstall.CheckedChanged += (s, e) => ShowChoice();
            run.Click += (s, e) => Start();
            close.Click += (s, e) => Close();
            open.Click += (s, e) => Process.Start(Installer.Explorer, Installer.DashboardUrl);
            FormClosing += (s, e) => e.Cancel = working;
            FormClosed += (s, e) => { if (removeFolderOnExit) Installer.RemoveInstallDirAfterExit(); };

            RefreshState();
            uninstall.Enabled = Installer.IsInstalled;
            if (startWithUninstall && uninstall.Enabled) uninstall.Checked = true; else install.Checked = true;
            ShowChoice();
        }

        void BuildInstallOptions()
        {
            installOptions.SetBounds(Left_, 104, Width_, 130);
            var group = new GroupBox { Text = "ACS sign-in (optional)", Bounds = new Rectangle(0, 0, Width_, 122) };
            group.Controls.Add(new Label { Text = "Leave blank to keep the current sign-in or enter it later in the dashboard's Setup view.", Bounds = new Rectangle(12, 20, Width_ - 24, 34) });
            AddField(group, "Username", acsUser, 56);
            AddField(group, "Password", acsPassword, 86);
            installOptions.Controls.Add(group);
            Controls.Add(installOptions);
        }

        static void AddField(Control parent, string label, TextBox box, int y)
        {
            parent.Controls.Add(new Label { Text = label, Bounds = new Rectangle(12, y + 3, LabelWidth - 12, 20) });
            box.SetBounds(LabelWidth, y, Width_ - LabelWidth - 14, 23);
            parent.Controls.Add(box);
        }

        void RefreshState()
        {
            state.Text = Installer.IsInstalled ? "Installed. Installing again upgrades it and keeps your settings." : "Not installed on this computer.";
            run.Text = !install.Checked ? "Uninstall" : Installer.IsInstalled ? "Upgrade" : "Install";
        }

        void ShowChoice()
        {
            installOptions.Visible = install.Checked;
            uninstallOptions.Visible = uninstall.Checked;
            RefreshState();
        }

        void Start()
        {
            Action<Installer> job;
            if (install.Checked)
            {
                Dictionary<string, string> credentials = ReadCredentials();
                if (credentials == null) return;
                job = i => i.Install(credentials);
            }
            else
            {
                bool delete = removeData.Checked;
                string question = delete ? "Remove Zone Roster and permanently delete its settings, credentials and badge history?" : "Remove Zone Roster?";
                if (MessageBox.Show(this, question, Text, MessageBoxButtons.YesNo, MessageBoxIcon.Warning, MessageBoxDefaultButton.Button2) != DialogResult.Yes) return;
                job = i => { i.Uninstall(delete); removeFolderOnExit = Installer.RunningFromInstallDir; };
            }

            acsPassword.Clear();
            bool installing = install.Checked;
            SetWorking(true);
            output.Clear();
            ThreadPool.QueueUserWorkItem(_ =>
            {
                string failure = null;
                try { job(new Installer(Log)); }
                catch (Exception e) { failure = e.Message; }
                BeginInvoke((Action)(() => Finish(failure, installing)));
            });
        }

        // Null if something entered needs correcting.
        Dictionary<string, string> ReadCredentials()
        {
            var values = new Dictionary<string, string>();
            string user = acsUser.Text.Trim(), password = acsPassword.Text;
            if ((user.Length == 0) != (password.Length == 0)) return Reject("Enter both the ACS username and password, or leave both blank.");
            if (user.Contains(":")) return Reject("ACS usernames cannot contain a colon.");
            if (user.Length > 0) { values["ACS_USERNAME"] = user; values["ACS_PASSWORD"] = password; }
            if (values.Values.Any(v => v.Any(char.IsControl))) return Reject("A value contains an invalid character.");
            return values;
        }

        Dictionary<string, string> Reject(string message)
        {
            MessageBox.Show(this, message, Text, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return null;
        }

        void Log(string line)
        {
            BeginInvoke((Action)(() => output.AppendText(line + Environment.NewLine)));
        }

        void SetWorking(bool busy)
        {
            working = busy;
            UseWaitCursor = busy;
            run.Enabled = close.Enabled = install.Enabled = !busy;
            uninstall.Enabled = !busy && Installer.IsInstalled;
        }

        void Finish(string failure, bool installing)
        {
            SetWorking(false);
            if (failure != null) output.AppendText("Stopped: " + failure + Environment.NewLine);
            else if (!installing) install.Checked = true;
            RefreshState();
            open.Enabled = failure == null && installing;
            if (open.Enabled && output.Text.Contains("Enter the ACS sign-in")) Process.Start(Installer.Explorer, Installer.DashboardUrl + "#setup");
        }
    }

    static class Program
    {
        [STAThread]
        static void Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new SetupForm(args.Contains("/uninstall", StringComparer.OrdinalIgnoreCase)));
        }
    }
}
