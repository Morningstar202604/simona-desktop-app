; Simona Desktop 安装脚本
; 请将此文件放在 Simona 打包输出目录（release\）中运行

[Setup]
AppName=Simona
AppVersion=1.0
AppVerName=Simona 1.0
DefaultDirName={autopf}\Simona
DefaultGroupName=Simona
OutputDir=.
OutputBaseFilename=Simona-1.0.0
Compression=lzma2/ultra64
SolidCompression=yes
LZMAUseSeparateProcess=yes
LZMANumFastBytes=273
PrivilegesRequired=admin
SetupIconFile=Simona\resources\.icon-ico\icon.ico
InfoBeforeFile=Simona\resources\安装说明.txt
UninstallDisplayIcon={app}\Simona Desktop.exe

[Languages]
Name: "ChineseSimplified"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加图标"; Flags: 
Name: "startup"; Description: "开机自动启动 Simona Desktop"; GroupDescription: "附加图标"; Flags:

[Files]
Source: "Simona\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\Simona"; Filename: "{app}\Simona Desktop.exe"
Name: "{commondesktop}\Simona"; Filename: "{app}\Simona Desktop.exe"; Tasks: desktopicon

[Registry]
; 添加开机自启动（当前用户）
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "Simona Desktop"; ValueData: """{app}\Simona Desktop.exe"""; Flags: uninsdeletevalue; Tasks: startup

[Run]
Filename: "{app}\Simona Desktop.exe"; Description: "立即运行 Simona Desktop"; Flags: nowait postinstall skipifsilent