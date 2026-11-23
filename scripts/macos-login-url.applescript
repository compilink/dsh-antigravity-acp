on acceptsLoginURL(requestedURL)
	-- AppleScript's text equality is case insensitive. Compare the actual characters.
	return (id of (requestedURL as text)) is equal to (id of "dsh-antigravity-login://authorize")
end acceptsLoginURL

on open location requestedURL
	if not my acceptsLoginURL(requestedURL) then return
	activate
	display dialog "要为此 Mac 上已绑定的 DSH 打开 Google 授权吗？继续后，终端将启动 Google 官方 Antigravity 程序。" with title "DSH Antigravity ACP" buttons {"取消", "继续"} default button "取消" cancel button "取消" with icon note
	set loginCommand to POSIX path of (path to resource "Login.command" in bundle (path to me))
	do shell script "/usr/bin/open -a /System/Applications/Utilities/Terminal.app " & quoted form of loginCommand
end open location
