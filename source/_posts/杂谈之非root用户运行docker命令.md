---
title: 杂谈之非root用户运行docker命令
date: 2021-12-08 14:57:59
tags:
---

# 步骤
## 1. 将用户添加至docker组中
```shell
usermod -aG docker currUser
 ```
`docker`命令本质上是通过访问(读写)`/var/run/docker.sock`来完成与`docker`的交互。`/var/run/docker.sock`默认属于`docker`组以及`root`用户，所以，要想获得`docker`命令执行权，需要将用户添加到`docker`组中。
ps: 如果docker组不存在，则需先执行：`sudo groupadd docker`
 	
## 2. 切换到docker组
```shell
newgrp docker
```
# 参考
[daemon-socket-option](https://docs.docker.com/engine/reference/commandline/dockerd/#daemon-socket-option)
