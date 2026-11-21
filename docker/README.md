# 默认工具镜像

内网工具复用已有的 NetExec、Impacket、SSH、sshpass、LDAP 客户端和 ProxyChains，补齐以下客户端：

| 范围 | Kali 包 | 主要命令 |
| --- | --- | --- |
| Kerberos 票据管理 | `krb5-user` | `kinit`、`klist`、`kdestroy` |
| Windows / Samba 共享与 RPC | `smbclient` | `smbclient`、`rpcclient` |
| Windows 远程管理 | `evil-winrm` | `evil-winrm` |
| AD 信息采集 | `bloodhound.py` | `bloodhound-python` |
| Linux NFS / RPC | `nfs-common` | `showmount`、`nfsstat`、`rpcinfo`（依赖提供） |
| Linux 文件传输与 rsync 服务访问 | `rsync` | `rsync` |

新增包通过 Kali APT 安装，支持 amd64 / arm64；使用 `--no-install-recommends`，清理包缓存和索引，并在构建时检查命令入口。BloodHound 仅安装 Python 采集器，分析界面及图数据库另行部署。

镜像增量目标为解压后不超过 300 MB。实际增量随 Kali rolling 版本和已有依赖变化，应以相同基础镜像下构建前后的 `docker image inspect --format '{{.Size}}' sentinel:latest` 差值为准。

源码部署可执行 `docker build -t sentinel:latest docker/`，也可在控制台「设置 → 环境」重建工具镜像。已有项目容器需在项目页重建后才会使用新工具，重建前应结束正在运行的任务。

此层只补充客户端，不增加容器权限。Kerberos 的域、KDC 和 DNS 配置按目标环境提供；安装 NFS 客户端不会自动赋予容器挂载权限。
