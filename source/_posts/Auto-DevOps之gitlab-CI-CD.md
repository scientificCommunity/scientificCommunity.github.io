---
title: Auto DevOps之gitlab CI/CD
tags:
  - 技术
  - 运维
categories: 技术
description: CI/CD是什么，如何应用gitlab CI/CD到我们的项目中？
abbrlink: 7dfe0119
date: 2021-08-02 00:12:36
---
# CI/CD介绍

**CI(Continuous Integration)**跟**CD(Continuous Delivery/Continuous Deployment)**的出现主要是为了帮助我们在开发时能更早的**发现代码中的bug**，避免我们**在这些bug上进行后续的开发**(一错再错-.-)，甚至将这些bug合并到qa或者staging环境去(错上加错)。

说人话就是，我们在提交代码到git时，git会**自动**通过脚本进行**build跟test**，如果这个过程失败了，我们会**得到通知**，这样我们就知道我们这次提交的代码是有问题的。同时这个检测过程**不用任何人工干预**(低成本)。

# CI/CD的工作流程

1. 开启一个新的分支
2. 运行自动化脚本来build或者test我们提交的代码
3. code review
4. 运行自动化脚本来deploy我们提交的代码

![https://docs.gitlab.com/ee/ci/introduction/img/gitlab_workflow_example_11_9.png](https://img-blog.csdnimg.cn/img_convert/4ab2d185d65e76a0d58ad6564dff777a.png)

# ci整体原理

1. `gitlab-runner`定时轮询(由`config.toml`的`check_interval`来指定间隔)`gitlab`指定的repo
2. 提交代码到指定分支
3. `gitlab-runner`检测到代码变动，执行项目中`.gitlab-ci.yml`中定义的脚本

# 安装gitlab runner

## 1. 创建一个由docker管理的volumes

```bash
 	docker volumes create gitlab-runner
```

  - 如果选择直接挂载一个文件目录，则忽略这一步
  - 相对于直接挂载一个文件目录，该方式有更好的可移植性，其他更多优势[请参考](https://docs.docker.com/storage/volumes/)

## 2. 创建并启动gitlab-runner容器

```yaml
    docker run -d --name gitlab-runner --restart always \
        -v /var/run/docker.sock:/var/run/docker.sock \
    		-v /bin/docker:/bin/docker \
        -v gitlab-runner-config:/etc/gitlab-runner \
        gitlab/gitlab-runner:latest
```
- 第一个挂载实现在容器内跟宿主机的`docker`通信（通过`curl`）
- 第二个挂载结合第一个挂载实现在容器内`docker.sock`执行宿主机`docker`命令

## 3. 注册gitlab-runner

```bash
    docker run --rm -it -v gitlab-runner-config:/etc/gitlab-runner gitlab/gitlab-runner:latest register
 ```
   1. 填写`GitLab instance URL`。这个就是我们的`gitlab`实例的地址，如果是自建的，就填上自建实例的域名，如果用的官方的，则填上`https://gitlab.com`
2. 填写`token`。打开对应项目`-->settings-->ci/cd-->runners`，即可看到`token`
3. 填写`description`. 这个根据这个`runner`的用途填写即可，没有特殊的
4. 填写`tags`. 这个tag让我们可以在`.gitlab-ci.yml`通过配置来决定本次提交由哪个`runner`来执行文件中的脚本
5. 选择`executor`. 这个我选择的是`shell`。目的是为了能够在容器内跟宿主机的`docker`通信。

## 4. 一些注意点
   1. 由于`ci`脚本默认由`gitlab-runner`这个用户执行，而这个用户是没有权限访问`docker.sock`的。所以，需要将`docker`组添加到`gitlab-runner`的附属组中。执行`usermod -aG docker gitlab-runner`
2. 如果依赖管理插件用的`gradle`,那么通常还需要`java`环境。
这个可以考虑把宿主机的`java`目录挂载进来
再在容器内配置`java`环境变量。或者也可以考虑重新安装
3. 如果用到了`docker-compose`，也需要在容器内安装：`apt-get install -y docker-compose`

# 编写.gitlab-ci.yml

先上一个案例：

```yaml
stages:
	- build
	- test
	- deploy
job1:
	stage: build
	only: xxx
	tags: defined in gitlab-runner
	before_script: do something
	script: 
	after_script: 
job2:
	stage: test
	allow_failure: true
	only: 
		changes:
			- "xxx.yaml"
job3:
	stage: deploy
	only: 
		refs:
			- main
		changes: 
			- "service-one/*"
```

## 1. [stages](https://docs.gitlab.com/ee/ci/yaml/#stages)


   - stages指定了ci job可能有的几个阶段。如果我们不指定，默认为build,test,deply。
   - 其定义的顺序决定了job执行的顺序。所以我们在定义有依赖关系的job时，如果其对应的
   - stage本身的顺序跟job的依赖顺序是一致的，就可以省略掉dependencies的定义。
   - 比如案例中的job2将在job1之后执行，与job的定义顺序无关，取决于stage的定义顺序。

## 2. job
  - 上述job1跟job2定义了两个job，job1是job的名字。
   - 只要不把job名设置为像stages这种关键字就没没问题。


## 3. [stage](https://docs.gitlab.com/ee/ci/yaml/#stage)
   指定当前job的阶段。注意，所有`stage`相同的`job`是可以并行运行的。
   这个并行数取决于`gitlab-runner`的配置文件`config.toml`中的`concurrent`来设置


## 4. [only](https://docs.gitlab.com/ee/ci/jobs/job_control.html#only-variables--except-variables-examples)
   这个就是指明在什么情况下触发CI。比如，
   - only后直接跟一个值(only: xxx)，则表示应用到哪个分支
   - only下的子项changes则表明哪里有变化(文件或者目录)则触发CI
   - only下的子项refs表明应用到哪个分支或者mr（值为merge_requests时）

## 5. [tags](https://docs.gitlab.com/ee/ci/yaml/#tags)  
   指定执行脚本的gitlab-runner。这个tag必须是gitlab-runner注册是填的tag
 

## 6. [allow_failure](https://docs.gitlab.com/ee/ci/yaml/#allow_failure)

  ` job`执行失败时是否影响后续的`job`执行。默认`false`
   `true`表示当前`job`执行失败不影响后续的`job`执行
   `false`表示当前job执行失败则终端整个[pipline](https://docs.gitlab.com/ee/ci/pipelines/)(所有的`job`跟`stage`组成的流程)

## 7. [before_script](https://docs.gitlab.com/ee/ci/yaml/#before_script)、[script](https://docs.gitlab.com/ee/ci/yaml/#script)、[after_script](https://docs.gitlab.com/ee/ci/yaml/#after_script)

   执行顺序从前到后。用法通常为
  ` before_script`: 初始化工作
  ` script`: 主体脚本
  ` after_script`: 收尾工作
