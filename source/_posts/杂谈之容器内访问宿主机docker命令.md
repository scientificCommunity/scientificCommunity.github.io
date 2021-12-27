---
title: 杂谈之容器内访问宿主机docker命令
abbrlink: 47873
date: 2021-09-20 08:42:56
tags:
---
# 原理
`docker`在被安装时默认会在`/var/lib/docker.sock`创建`unix domain socket`。`docker daemon`会通过它来监听[Docker Engine API](https://docs.docker.com/engine/api/) 请求。而`docker`命令本质上是在`/bin/docker`里包装了这些请求交互的细节(猜想，有研究过的朋友可以分享一下🤝)。所以我们只需要将这两个文件挂载到容器中即可。

*如果只挂载`/var/lib/docker.sock`，我们查看容器列表(`docker ps`)就需要这样操作：*
```shell
curl -s --unix-socket /var/run/docker.sock http://dummy/containers/json
```

**总的来说：**
1. `/var/lib/docker.sock`保证能跟`docker daemon`通信
2. `/bin/docker`隐藏通信细节
# 具体操作
```shell
docker run -d --name <yourContainerName>
    -v /var/run/docker.sock:/var/run/docker.sock \
	-v /bin/docker:/bin/docker \
```
# 注意点
1. 如果`docker`容器内需要访问宿主机`docker`命令的用户不是`root`用户或者不属于`docker`组的用户，则还需执行：
	```shell
	sudo usermod -aG docker $USER
	```
2. 如果容器基于`Alpine Linux`，基于 `glibc` 构建的`/bin/docker`是无法执行的。所以还需要执行如下操作：
	```shell
	wget -q -O /etc/apk/keys/sgerrand.rsa.pub https://alpine-pkgs.sgerrand.com/sgerrand.rsa.pub
	
	wget https://github.com/sgerrand/alpine-pkg-glibc/releases/download/2.34-r0/glibc-2.34-r0.apk
	
	apk add glibc-2.34-r0.apk
    ```
# 参考
[杂谈之非root用户运行docker命令](https://blog.csdn.net/scientificCommunity/article/details/120386344)
[Daemon socket option](https://docs.docker.com/engine/reference/commandline/dockerd/#daemon-socket-option)
[alpine-pkg-glibc](https://github.com/sgerrand/alpine-pkg-glibc)
