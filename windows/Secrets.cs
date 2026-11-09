// The encrypted credentials file, shared by the installer and the service host. It holds KEY=VALUE lines
// encrypted with DPAPI for this machine. Any process on the machine could decrypt it, so the file's
// permissions are what keep it private: only the service and administrators can open it.

using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Text;

namespace ZoneRoster
{
    static class Secrets
    {
        public static readonly string[] Names = { "ACS_USERNAME", "ACS_PASSWORD" };

        public static string FileIn(string dataDir) { return Path.Combine(dataDir, "secrets.dat"); }

        // An empty file means nothing has been stored yet.
        public static Dictionary<string, string> Read(string file)
        {
            var values = new Dictionary<string, string>();
            byte[] stored = File.ReadAllBytes(file);
            if (stored.Length == 0) return values;
            byte[] plain = ProtectedData.Unprotect(stored, null, DataProtectionScope.LocalMachine);
            foreach (string line in Encoding.UTF8.GetString(plain).Split('\n'))
            {
                int eq = line.IndexOf('=');
                if (eq > 0 && Array.IndexOf(Names, line.Substring(0, eq)) >= 0) values[line.Substring(0, eq)] = line.Substring(eq + 1);
            }
            return values;
        }

        // Rewrites the existing file in place, so its permissions are never at risk.
        public static void Write(string file, Dictionary<string, string> values)
        {
            var text = new StringBuilder();
            foreach (var pair in values) text.Append(pair.Key).Append('=').Append(pair.Value).Append('\n');
            byte[] stored = ProtectedData.Protect(Encoding.UTF8.GetBytes(text.ToString()), null, DataProtectionScope.LocalMachine);
            using (var stream = new FileStream(file, FileMode.Open, FileAccess.Write, FileShare.None))
            {
                stream.Write(stored, 0, stored.Length);
                stream.SetLength(stored.Length);
                stream.Flush(true);
            }
        }

        // Updates some values and keeps the rest. Unreadable contents are replaced rather than blocking a repair.
        public static void Merge(string file, Dictionary<string, string> changes)
        {
            Dictionary<string, string> values;
            try { values = Read(file); }
            catch (CryptographicException) { values = new Dictionary<string, string>(); }
            foreach (var pair in changes) values[pair.Key] = pair.Value;
            Write(file, values);
        }
    }
}
