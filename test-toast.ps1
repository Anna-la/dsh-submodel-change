# 手动验证 Windows 通知通道:应弹出「DeepSeek Harness - 测试通知」。
# 右键「使用 PowerShell 运行」或: powershell -NoProfile -ExecutionPolicy Bypass -File test-toast.ps1
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$title = [System.Security.SecurityElement]::Escape('DeepSeek Harness')
$body = [System.Security.SecurityElement]::Escape('测试通知: agent 操作已完成')
$xmlText = '<toast><visual><binding template="ToastText02"><text id="1">' + $title + '</text><text id="2">' + $body + '</text></binding></visual></toast>'
$xml = [Windows.Data.Xml.Dom.XmlDocument]::new()
$xml.LoadXml($xmlText)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Microsoft.WindowsPowerShell').Show([Windows.UI.Notifications.ToastNotification]::new($xml))
Write-Host 'toast-shown'