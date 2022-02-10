---
title: vert.x源码浅析之redis集成
tags:
  - 技术
  - vertx
  - 浅析
  - 源码
categories: 技术
description: vert.x是一个全异步框架，通过内部的event bus跟event loop做到了处处皆异步...
abbrlink: 4fc0a6f7
date: 2020-11-10 14:58:19
---
# vertx是什么
vert.x是一个全异步框架，通过内部的event bus跟event loop做到了处处皆异步。关于里面的细节，后面我会出一篇文章详细跟大家探讨...
# 为什么要用vertx
充分利用机器性能，提升应用的吞吐量上限。

# vertx-redis-client是什么
通俗来讲，vertx-redis提供了一个`全异步`的可配置的`redis客户端`
# vertx-redis-client有哪些特性
相对常规的jedis或者Lettuce来说，这里的特性其实就是vertx贯穿全局的特性：异步。当我们调用api发送一条redis指令的时候，可以`不用等待`redis的响应，只需要绑定一个`回调函数`，程序就可以继续往下执行。当拿到redis的响应之后，就会触发这个回调。当然，像这种编程方式，需要把`业务依赖关系`处理得很明确，因为我们必须把依赖这个redis响应的所有处理都移到这个回调函数里去。
# 怎么使用vertx-redis-client
## 添加vertx-redis-client依赖
```java
//gradle
compile("io.vertx:vertx-redis-client:$version")
//maven
<dependency>
  <groupId>io.vertx</groupId>
  <artifactId>vertx-redis-client</artifactId>
  <vertion></version>
</dependency>
```
## RedisConnection
RedisConnection是vertx-redis-client里暴露出来可操作redis的最基本的一组api了，使用如下
```java
  Redis
    .createClient(Vertx.vertx(), "redis://ip:port")
    .connect(onConnect -> {
       //连接成功
       if (onConnect.succeeded()) {
           //获取连接实例
           RedisConnection conn = onConnect.result();
           //创建redis get指令. 
           Request command = Request.cmd(Command.GET);
           //添加指令参数aa. 最后到达redis的指令就是get aa
           command.arg("aa");
           //发送指令
           conn.send(command, resp -> {
               //执行成功
               if (resp.succeeded()) {
                   //拿到指令执行结果
                   Response result = resp.result();
               }
           });
       }
   });
```
这里就谈谈怎么使用吧，其实内部的实现就是通过netty包装的channel跟redis建立起连接，有兴趣的朋友可以点进去看看。

## redisOptions
在介绍该redisClient各种模式之前，我们需要了解options是什么。
简单来说，redisOptions是我们用来定制该redisClient的一种方式，像之前我们通过==Redis.createClient(Vertx.vertx(), "redis://ip:port")== 这种仅仅提供一个地址的方式就建立起了一个redisClient，但是如果我们想要定制更复杂的redisClient呢？这个时候就需要用到redisOptions了
### 各项主要配置的含义
先大概看下redisOptions都有哪些属性：
```java
public class RedisOptions {

  /**
   * The default redis endpoint = {@code redis://localhost:6379}
   */
  public static final String DEFAULT_ENDPOINT = "redis://localhost:6379";
  
  private RedisClientType type;
  private NetClientOptions netClientOptions;
  private List<String> endpoints;
  private int maxWaitingHandlers;
  private int maxNestedArrays;
  private String masterName;
  private RedisRole role;
  private RedisSlaves slaves;
  private String password;

  // pool related options
  private int poolCleanerInterval;
  private int maxPoolSize;
  private int maxPoolWaiting;
  private int poolRecycleTimeout;
}
```
#### type
该枚举用于指定redisClient以什么模式去连接server，这里的模式跟redis server的模式一一对应，我们在用的时候也必须注意，server是以什么模式部署的，client就以什么模式去配置。源码如下
```java
public enum RedisClientType {

  /**
   * 默认值，单机模式
   */
  STANDALONE,

  /**
   * 哨兵
   */
  SENTINEL,

  /**
   * 集群
   */
  CLUSTER
}
```
这些配置决定了redisClient与server交互的方式，不同的类型会用不同的策略来应对，在我们调用Redis#creatClient的时候就会作出处理，源码如下
```java
static Redis createClient(Vertx vertx, RedisOptions options) {
    switch (options.getType()) {
      case STANDALONE:
        return new RedisClient(vertx, options);
      case SENTINEL:
        return new RedisSentinelClient(vertx, options);
      case CLUSTER:
        return new RedisClusterClient(vertx, options);
      default:
        throw new IllegalStateException("Unknown Redis Client type: " + options.getType());
    }
  }
  ```
至于不同Client内部是怎么处理的，后面会一一介绍
#### masterName
这个只在Sentinel模式下有用，跟redisServer的redis_sentinel.conf里配置的masterName是一个东西，用来指明连接的是被哨兵监控的哪一个主从集群
#### role

这项配置只用于clientType为Sentinel的情况，主要用来指定当前的客户端到底是跟master连接还是只跟slave连接，如果配置为slave，则通过该客户端发起的所有指令都会被路由到slave节点，这意味着这个client对redisServer的所有操作都是只读的。
还有一个sentinel，这个意味着这个client只操作server端的sentinel，不会主动去获取到master或者slave的连接。按我目前看来，这个枚举值其实是给程序内部使用的，除非我们想手动实现跟哨兵的通信以及维护相应主从节点的一个failover情况，那么就可以使用这个配置。核心源码在RedisSentinelClient中，如下所示

```java
private void createConnectionInternal(RedisOptions options, RedisRole role, Handler<AsyncResult<RedisConnection>> onCreate) {
    switch (role) {
      case SENTINEL:
        resolveClient(this::isSentinelOk, options, createAndConnect);
        break;

      case MASTER:
        resolveClient(this::getMasterFromEndpoint, options, createAndConnect);
        break;

      case SLAVE:
        resolveClient(this::getSlaveFromEndpoint, options, createAndConnect);
    }
  }
  ```
  这里可以看到，根据不同的role，获取了不同类型的redis连接地址
  ```java
  private void getMasterFromEndpoint(String endpoint, RedisOptions options, Handler<AsyncResult<String>> handler) {
    final RedisURI uri = new RedisURI(endpoint);
    connectionManager.getConnection(context, getSentinelEndpoint(uri), null, onCreate -> {
      final RedisConnection conn = onCreate.result();
      final String masterName = options.getMasterName();
      
	  // 根据masterName从sentinel获取相应主从集群的master节点信息
      conn.send(cmd(SENTINEL).arg("GET-MASTER-ADDR-BY-NAME").arg(masterName), getMasterAddrByName -> {
        //bala bala...
      });
    });
 ```
```java
private void getSlaveFromEndpoint(String endpoint, RedisOptions options, Handler<AsyncResult<String>> handler) {
  final RedisURI uri = new RedisURI(endpoint);
    connectionManager.getConnection(context, getSentinelEndpoint(uri), null, onCreate -> {
      
      final RedisConnection conn = onCreate.result();
      final String masterName = options.getMasterName();
      // 获取masterName指定主从的slave节点
      conn.send(cmd(SENTINEL).arg("SLAVES").arg(masterName), sentinelSlaves -> {
        //...
      });
    });
  }
  ```
#### slaves
这项配置用来指定在集群模式下对server的读操作的行为，源码如下
```java
public enum RedisSlaves {

  /**
   * 读操作只落在master
   */
  NEVER,

  /**
   * 读操作会随机落在master跟slave
   */
  SHARE,

  /**
   * 读操作只落在slave上
   */
  ALWAYS
}
```
其核心原理是通过对slave节点执行readonly命令来开启slave的查询功能，因为默认集群模式下slave是不对外提供服务的。核心源码如下
```java
private void connect(List<String> endpoints, int index, Handler<AsyncResult<RedisConnection>> onConnect) {
	//如果RedisSlaves的值不是NEVER,就执行readonly
    connectionManager.getConnection(context, endpoints.get(index), RedisSlaves.NEVER != options.getUseSlave() ? cmd(READONLY) : null, getConnection -> {
    }
}
```
#### poolCleanerInterval
连接池空闲连接清理间隔，每次扫描时会直接将闲置的连接关闭。`-1`表示不开启空闲连接清理，核心源码在RedisConnectionManager#start()
```java
synchronized void start() {
    long period = options.getPoolCleanerInterval();
    //延迟period时间后执行checkExpired()进行空闲连接清理
    this.timerID = period > 0 ? vertx.setTimer(period, id -> checkExpired(period)) : -1;
  }
   ```
#### poolRecycleTimeout
这个是用来控制连接池中连接在执行完命令后还能存活的时间，超过这个时间连接就会被关闭，核心源码在`RedisStandaloneConnection`。如下
```java
public boolean isValid() {
    return expirationTimestamp > 0 && System.currentTimeMillis() <= expirationTimestamp;
  }

  @Override
  public void close() {
    // recycle this connection from the pool
    expirationTimestamp = recycleTimeout > 0 ? System.currentTimeMillis() + recycleTimeout : 0L;
    listener.onRecycle();
  }
  ```
#### maxPoolSize
连接池最大大小。`只有当等待获取连接的请求数量达到maxPoolWaiting时才会创建新的连接`，可以类比`ThreadPoolExecutor`的`maximumPoolSize`
#### maxPoolWaiting
连接池等待队列大小。当我们通过RedisClient或者RedisApi去操作reids时，如果当前已无空闲的redis连接，那么这个请求就会进入连接池的等待队列中。可以类比`ThreadPoolExecutor`的`workQueue`
#### maxWaitingHandlers
等待执行的handler数的最大值。当我们发送完redis指令后，一般是需要对这个响应作出处理，这个过程会被包装成一个`task`添加到`eventLoop`的`waitQueue`中，这项配置控制的就是这个`queue`的`size`
## RedisClient 
redisClient本质是对上述redisConnection的再封装，提供了针对redisServer不同模式的不同处理，分为3种：单机，哨兵以及集群模式。对应到具体的class：`RedisClient`、`RedisSentinelClient`、`RedisSentinelClient`
接下来来看一下如何配置这些客户端
### STANDALONE
这个是redisClient默认的一种配置模式，现在我们用前面描述的redisOptions实践一下。
```java
    RedisOptions options = new RedisOptions();
    options.setType(RedisClientType.STANDALONE)
            //指定server地址
            .setConnectionString("redis://ip:port")
            .setMaxPoolSize(6)
            .setMaxWaitingHandlers(1024)
            .setPoolRecycleTimeout(15_000)
            .setMaxPoolWaiting(2);

    Redis client = Redis.createClient(Vertx.vertx(), options);
    //创建redis 指令. get
    Request command = Request.cmd(Command.GET);
    //添加指令参数aa. 最后到达redis的指令就是get aa
    command.arg("aa");
    //发送指令并指定一个匿名handler处理结果
    client.send(command).onComplete(event -> {
        System.out.println("the value of redis key 'aa' is"+event.result().toString());
    });
```
### SENTINEL
这里请原谅我秀了一下我那蹩脚的英语水平...
```java
    RedisOptions options = new RedisOptions();
    options.setType(RedisClientType.SENTINEL)
            //the master name which are monitored by sentinels
            .setMasterName("myMaster")
            .setRole(RedisRole.MASTER)
            .setMaxPoolSize(6)
            .setMaxWaitingHandlers(1024)
            .setPoolRecycleTimeout(15_000)
            .setMaxPoolWaiting(2);

    //这里只填哨兵的地址就行了
    //程序会自动从哨兵处获取节点信息
    List<String> sentinels = new ArrayList<>();
    sentinels.add("redis://ip:port");
    sentinels.add("redis://ip:port");
    options.setEndpoints(sentinels);
    
    ...
```
这里可以只填一个哨兵地址，由于client不会主动去连接监控同一个master的哨兵节点，所以一旦这个唯一的哨兵挂了，那么server就会处于不可用的状态。
### CLUSTER
```java
    RedisOptions options = new RedisOptions();
    options.setType(RedisClientType.CLUSTER)
            .setUseSlave(RedisSlaves.NEVER)
            .setMaxPoolSize(6)
            .setMaxWaitingHandlers(1024)
            .setPoolRecycleTimeout(15_000)
            .setMaxPoolWaiting(20);
	//添加集群节点，越多越好...
    List<String> clusters = new ArrayList<>();
    sentinels.add("redis://ip:port");
    sentinels.add("redis://ip:port");
    sentinels.add("redis://ip:port");
    options.setEndpoints(clusters);
```
这里也需要注意最好将cluster中所有的节点信息给添加进来。虽然连接任意一个节点，client都会通过执行`cluster slots`获取cluster中所有节点的信息，但是长久保持连接的只有我们在这里设置进去的节点。这意味着一旦我们手动设置的节点挂了，那么server对我们来说就不可用了
## RedisApi
这个是基于`RedisClient`的封装，隐藏了`Command`的复杂细节，提供了一套可以直接调用的api。使用如下：
```java
    Redis client = Redis.createClient(Vertx.vertx(), options);
    RedisAPI api = RedisAPI.api(client);
    api.get("aa").onComplete(event -> {
        System.out.println("the value of redis key 'aa' is" + event.result().toString());
    });
```
# 总结
全文描述了vertx-client是什么以及其相对某些redis-client所具备的特点。同时深挖了这个客户端各项配置的作用以及不同模式下的表现。
总的来说，这篇文章可以帮助大家去建立一个`基于vertx的redis客户端`，并且对这个客户端能够做到基本的`知其然且知其所以然`。
