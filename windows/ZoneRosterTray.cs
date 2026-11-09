// System tray icon for Zone Roster. Click it to open the dashboard; the icon turns grey and the
// tooltip changes when the dashboard isn't reachable.
//
//   ZoneRosterTray.exe [path\to\config.json]
//
// The address is read from the config file each time it's needed, so a changed port is picked up
// without restarting the tray. Written for the C# 5 compiler that ships with Windows.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Net;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace ZoneRoster
{
    sealed class TrayContext : ApplicationContext
    {
        const int CheckEveryMs = 15000;
        const int RequestTimeoutMs = 3000;

        readonly string configFile;
        readonly Icon upIcon = DrawIcon(Color.FromArgb(110, 168, 255), Color.FromArgb(95, 224, 161), Color.FromArgb(199, 146, 255));
        readonly Icon downIcon = DrawIcon(Color.FromArgb(140, 140, 140), Color.FromArgb(140, 140, 140), Color.FromArgb(140, 140, 140));
        readonly NotifyIcon tray;
        readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer { Interval = CheckEveryMs };
        readonly SynchronizationContext ui;

        public TrayContext(string configFile)
        {
            this.configFile = configFile;
            ui = SynchronizationContext.Current ?? new WindowsFormsSynchronizationContext();

            var menu = new ContextMenuStrip();
            var open = new ToolStripMenuItem("Open Zone Roster", null, (s, e) => OpenDashboard());
            open.Font = new Font(open.Font, FontStyle.Bold);
            menu.Items.Add(open);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(new ToolStripMenuItem("Exit tray icon", null, (s, e) => Quit()));

            tray = new NotifyIcon { Icon = downIcon, Text = "Zone Roster: checking", ContextMenuStrip = menu, Visible = true };
            tray.MouseClick += (s, e) => { if (e.Button == MouseButtons.Left) OpenDashboard(); };

            timer.Tick += (s, e) => CheckStatus();
            timer.Start();
            CheckStatus();
        }

        string DashboardUrl()
        {
            string host = "127.0.0.1";
            int port = 8787;
            try
            {
                var root = new JavaScriptSerializer().DeserializeObject(File.ReadAllText(configFile)) as Dictionary<string, object>;
                object section;
                if (root != null && root.TryGetValue("server", out section))
                {
                    var server = section as Dictionary<string, object>;
                    object value;
                    if (server != null && server.TryGetValue("host", out value) && value is string) host = (string)value;
                    if (server != null && server.TryGetValue("port", out value)) port = Convert.ToInt32(value);
                }
            }
            catch (Exception) { } // missing or unreadable config: the app's defaults still apply

            if (host == "" || host == "0.0.0.0" || host == "::") host = "127.0.0.1";
            if (host.Contains(":") && !host.StartsWith("[")) host = "[" + host + "]";
            return new UriBuilder("http", host, port).Uri.ToString();
        }

        void OpenDashboard()
        {
            try { Process.Start(DashboardUrl()); }
            catch (Exception e) { tray.ShowBalloonTip(5000, "Zone Roster", "Couldn't open the browser: " + e.Message, ToolTipIcon.Warning); }
        }

        void CheckStatus()
        {
            string url = DashboardUrl() + "api/status";
            ThreadPool.QueueUserWorkItem(_ =>
            {
                bool up = IsReachable(url);
                ui.Post(__ => ShowStatus(up), null);
            });
        }

        static bool IsReachable(string url)
        {
            var request = (HttpWebRequest)WebRequest.Create(url);
            request.Timeout = RequestTimeoutMs;
            request.Proxy = null;
            try
            {
                using (var response = (HttpWebResponse)request.GetResponse())
                    return response.StatusCode == HttpStatusCode.OK;
            }
            catch (WebException) { return false; }
        }

        void ShowStatus(bool up)
        {
            tray.Icon = up ? upIcon : downIcon;
            tray.Text = up ? "Zone Roster: running" : "Zone Roster: dashboard not reachable";
        }

        void Quit()
        {
            timer.Stop();
            tray.Visible = false;
            ExitThread();
        }

        // The app's icon, three zones on a dark tile, simplified to stay readable at tray size.
        static Icon DrawIcon(Color tall, Color upper, Color lower)
        {
            using (var bitmap = new Bitmap(32, 32))
            using (var g = Graphics.FromImage(bitmap))
            using (var path = new GraphicsPath())
            using (var tile = new SolidBrush(Color.FromArgb(20, 32, 58)))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                const int r = 12;
                path.AddArc(0, 0, r, r, 180, 90);
                path.AddArc(31 - r, 0, r, r, 270, 90);
                path.AddArc(31 - r, 31 - r, r, r, 0, 90);
                path.AddArc(0, 31 - r, r, r, 90, 90);
                path.CloseFigure();
                g.FillPath(tile, path);
                FillZone(g, tall, 5, 5, 10, 22);
                FillZone(g, upper, 17, 5, 10, 10);
                FillZone(g, lower, 17, 17, 10, 10);
                return Icon.FromHandle(bitmap.GetHicon()); // two icons live as long as the process
            }
        }

        static void FillZone(Graphics g, Color color, int x, int y, int width, int height)
        {
            using (var brush = new SolidBrush(color)) g.FillRectangle(brush, x, y, width, height);
        }
    }

    static class Program
    {
        [STAThread]
        static void Main(string[] args)
        {
            bool first;
            using (new Mutex(true, @"Local\ZoneRosterTray", out first))
            {
                if (!first) return; // already in this user's tray
                string config = args.Length > 0 ? args[0] : Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "ZoneRoster", "config.json");
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new TrayContext(config));
            }
        }
    }
}
