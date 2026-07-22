# 安装此刻

## 从 Release 安装

1. 在 GitHub [Releases](https://github.com/differance-dfhs/cike/releases) 下载最新 `.dmg`。
2. 打开镜像，把“此刻”拖入 Applications。
3. 从 Applications 启动。

公开预览包采用 ad-hoc 签名，尚未经过 Apple notarization。若首次启动被系统拦截：

1. 打开“系统设置 → 隐私与安全性”。
2. 在安全提示处选择“仍要打开”。
3. 回到 Applications 再次启动。

不要从来历不明的镜像安装。Release 同时提供 SHA-256 文件，可用于核对下载内容。

## 首次配置

此刻不会附带任何构建者的数据。首次启动后，每位用户分别选择：

- 是否读取 Codex 的本地活动状态；
- 是否连接日历、会议或协作工具；
- 哪些本地项目目录可以读取；
- 是否允许在已验证项目中执行可逆改动。

没有启用的来源会保持关闭，不会使用演示截图中的内容。

## 卸载

退出此刻后，从 Applications 删除应用即可。若还希望清除本机状态，可同时删除该应用对应的 macOS Application Support 目录。
