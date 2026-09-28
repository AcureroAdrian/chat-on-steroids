import { execFile } from 'node:child_process';

/**
 * A Windows toast for the moments the user should know about even if nobody reads the agent's
 * transcript: the app was killed, or restarting it did not help. Text travels through environment
 * variables and is XML-escaped inside PowerShell, so nothing in it is ever parsed as script.
 * Failures are ignored: a missing notification must never fail the action it reports.
 */
const SCRIPT = [
  '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
  '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
  '$title = [Security.SecurityElement]::Escape($env:COS_MCP_TOAST_TITLE)',
  '$body = [Security.SecurityElement]::Escape($env:COS_MCP_TOAST_BODY)',
  '$xml = New-Object Windows.Data.Xml.Dom.XmlDocument',
  "$xml.LoadXml(\"<toast><visual><binding template='ToastGeneric'><text>$title</text><text>$body</text></binding></visual></toast>\")",
  "$app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'",
  '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($xml))'
].join('\n');

export function notify(title: string, body: string): Promise<void> {
  if (process.platform !== 'win32' || process.env.COS_MCP_NO_TOAST === '1') return Promise.resolve();
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SCRIPT],
      {
        windowsHide: true,
        timeout: 15_000,
        env: { ...process.env, COS_MCP_TOAST_TITLE: title.slice(0, 120), COS_MCP_TOAST_BODY: body.slice(0, 400) }
      },
      () => resolve()
    );
  });
}
