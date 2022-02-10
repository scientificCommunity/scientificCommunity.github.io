---
title: Vertx实战之如何追踪异步函数调用
tags:
  - 技术
  - jvm
  - 实战
  - Vertx
categories: 技术
abbrlink: 6a250a7b
date: 2021-06-03 19:31:41
---
# 背景

日常开发中我们经常需要处理各种系统问题，而这些系统问题通常由一些非预期的因素引起（比如非预期的输入，内存不够，网络波动等）。此时就需要知道
1. 本次系统问题影响了谁？
2. 如果本次系统问题是因为非预期的输入而导致的，那么这个非预期的输入是什么？

上述两点在同步编程里可以通过全局try-catch来实现。但在异步编程里该怎么办呢？

---

# 思路
我的想法是绑定一个唯一id到一次完整的请求调用中（这个完整取决于我们想要监控的范围），无论程序执行到何处，我们总能拿到与请求一一对应的`调用上下文`的id。

  我将分两种场景进行讨论。一种是同步或基于jut下的线程池类进行异步调用的应用程序（如基于spring5之前的应用程序）。另外一种基于vertx（底层基于netty）的应用程序。
  
  ---

## 技术栈

`vert.x 4`、`netty 4`、[`alibaba TransmittableThreadLocal`](https://github.com/alibaba/transmittable-thread-local)、`jboss javassist`、hotspot类加载&方法调用

---
## 1. 同步or基于jdk的异步

**关于这种场景，有以下几种实现：**

1. **程序中的函数调用是完全同步的**

    则可通过`java.lang.ThreadLocal`绑定一个唯一id到当前线程。入口处生成，出口处销毁。
    如果我们用的是logback，也可通过 `org.slf4j.MDC` 来实现这个功能。其内部也是基于ThreadLocal。

2. **程序中函数调用是异步的，异步通过新建`java.lang.Thread` 的方式实现。**

    这里可通过`java.lang.InheritableThreadLocal` 绑定一个唯一id到当前线程。`Thread`的构造函数里会自动把通过`InheritableThreadLocal` 绑定到当前线程的数据拷贝到这个正在创建的`Thread` 里。所以，只要这个`Thread` 是在我们**需要监控的区域（当前线程通过**`InheritableThreadLocal`**绑定了id后）**创建的，就能实现这个唯一id的跨线程传递。

3. **程序中函数调用是异步的，异步通过`java.util.concurrent` 下的线程池类实现。**

    由于线程池中的线程是可以复用的，所以，如果我们往线程池中丢任务时，有两种情况：

    1. 线程池创建新的线程来执行该任务（比如线程池中的线程数<coreSize）。这种情况下`InheritableThreadLocal` 依然是有效的。
    2. 线程池把任务分配给了已有线程（比如线程池中的线程数≥coreSize并且待执行任务队列没有填满）。这种情况下`InheritableThreadLocal` 是无法生效的（线程池中的存活线程会循环拉取等待任务队列中的task去执行，而这个过程是没有`InheritableThreadLocal` 拷贝的）。所以，这里可以用阿里的`[TransmittableThreadLocal](https://github.com/alibaba/transmittable-thread-local)` 组件来实现这个唯一id在线程池中的传递（其核心原理是在`Runnable` 中用一个变量来存储当前线程的ThreadLocal值，当线程执行此Runnable时再拿出来）。

---
### 实现思路总结

  异步环境下的关键在于如何跨线程传递ThreadLocal的值

---
## 2. Vertx 中的实现

  `vertx`是一个类似于`spring`系列的用于构建分布式微服务的框架。基于`vertx`构建的应用程序最大的特点是**无阻塞**&**全异步。**

  vertx里的异步主要分两种。一种是在eventbus上传递消息的异步。另一种是基于netty的io操作异步


### 1. eventbus上异步传递消息

   先来看一个简单的示例程序

```java
	static final String ADDRESS_1 = "address1";
  static final String MESSAGE_1 = "message1";
  static final String REPLY_MESSAGE_1 = "replyMessage1";

	public static void sendMsgByEventbus() {
        //初始化一个具有默认设置的vertx实例
        Vertx vertx = Vertx.vertx();

        //注册一个handler/consumer到eventbus
        vertx.eventBus().consumer(ADDRESS_1, event -> {
            log.info("receive msg:{}", event.body());
            event.reply(REPLY_MESSAGE_1);
        });

        //通过eventbus发送消息给刚注册的handler
        vertx.eventBus().request(ADDRESS_1, MESSAGE_1, reply -> {
            log.info("receive replied msg:{}", reply.result().body());
        });
    }
```

下面是程序执行的结果

```java
[vert.x-eventloop-thread-0] - receive msg:message1
[vert.x-eventloop-thread-0] - receive replied msg:replyMessage1
```

可以看到发起调用的是主线程，处理调用跟处理回调的是线程`vert.x-eventloop-thread-0`。

那么，这个异步是如何实现的呢？显然，异步最明显的体现就是最后发送消息这里。所以我们就从`Eventbus#request` 逐步深入。

**大概流程是这样的：**

1. 从`eventbus`中根据我们传入的`address`拿到所有注册到这个地址上的handler。
2. 将对应`handler`对传入消息的处理包装成一个`runnable`丢进一个`queue`
3. `eventLoop Thread`从这个`queue`中抓取`task`执行

**关键代码片段如下：**

```java
//与本主题无关的只展示调用链路供大家参考
//Eventbus#request
//  EventbusImpl#request
//    EventbusImpl#sendOrPubInternal
//      EventbusImpl#sendOrPubInternal
//        EventbusImpl#OutboundDeliveryContext
//          EventbusImpl#sendOrPub
//            EventbusImpl#sendLocally
//              EventbusImpl#deliverMessageLocally

protected ReplyException deliverMessageLocally(MessageImpl msg) {
	  //1.找出跟msg.address()的handlerHolder
	  ConcurrentCyclicSequence<HandlerHolder> handlers = handlerMap.get(msg.address());
	  if (handlers != null) {
	    for (HandlerHolder holder: handlers) {
		  //2.依次调用这些handler的receive方法
	      holder.handler.receive(msg.copyBeforeReceive());
	    }
	    return null;
	  }
}

void receive(MessageImpl msg) {
	  //3.匿名异步任务进队列
	  context.nettyEventLoop().execute(() -> {
	     doReceive(msg);
	  });
}

//SingleThreadEventExecutor#execute
private void execute(Runnable task, boolean immediate) {
	//比较当前线程是否是eventLoop线程，是则返回true
	//由于我们在main里调用的eventbus#request,所以这里是false
    boolean inEventLoop = inEventLoop();

	//4. 添加到queue中，后面执行任务的线程会调用该queue的poll方法
    addTask(task);

    if (!inEventLoop) {
		//如果当前eventLoop对象的thread为空则创建一个Thread绑定到当前eventLoop
        startThread();
    }
}

//eventLoop中运行的thread通过这个方法从上面说的queue中拿task执行
//外层会循环执行该runAllTasks，直到Eventloop#shutdownGracefully被执行
//参考NioEventLoop#run
protected boolean runAllTasks(long timeoutNanos) {
      Runnable task = pollTask();
      
      for (;;) {
		  //5.执行task
          safeExecute(task);

          runTasks ++;
					
		  //如果队列中还有task，则继续执行
          task = pollTask();
          if (task == null) {
              lastExecutionTime = ScheduledFutureTask.nanoTime();
              break;
          }
      }
      return true;
  }

protected static Runnable pollTaskFrom(Queue<Runnable> taskQueue) {
    for (;;) {
        Runnable task = taskQueue.poll();
        if (task != WAKEUP_TASK) {
            return task;
        }
    }
}

//safeExecute会去执行第3步中的匿名任务
protected boolean doReceive(Message<T> message) {
		Handler<Message<T>> theHandler = handler;
		
		deliver(theHandler, message);
		return true;
}

//MessageConsumerImpl#deliver
//  MessageConsumerImpl#dispatch
//    AbstractContext#dispatch
//      InboundDeliveryContext#dispatch   ++ 上一步的匿名Runnable会调用 
//        InboundDeliveryContext#next
//          MessageConsumerImpl#dispatch
//            DuplicatedContext#emit
//              EventLoopContext#emit
<T> void emit(AbstractContext ctx, T argument, Handler<T> task) {
    try {
	  //6.执行handler/task中的事件处理
	  //这个task就是我们之前通过Eventbus#consumer注册进来的
      task.handle(argument);
    } catch (Throwable t) {
      reportException(t);
    } finally {
      ctx.endDispatch(prev);
    }
}
```

我删减了一些不重要的部分，以便更易于理解。

通过上面的代码片段我们可以发现，第3步的`SingleThreadEventExecutor#execute`往队列里push任务似乎是解决问题（跨线程传递唯一id）的关键。所以，如果我们能够**在这个task进入`queue`之前往这个task中塞上当前线程的`ThreadLocal`值，待到这个`task`的`run`方法被执行时再把这个`ThreadLocal`值拿出来塞到当前线程（执行这个`task`的线程）的`ThreadLocal`中**，问题就解决了。

显然，我们需要修改这些类的代码。那么，怎么实现这个功能呢？

`java.lang.instrument` 提供了一系列运行时替换class字节码的技术。而[jboss Javaassist](https://github.com/jboss-javassist/javassist) 则提供了一些列修改字节码的接口。所以我们只需要结合这两项技术再通过javaagent指令即可达成我们的目的。

修改字节码的实现可参考[这里](https://github.com/scientificCommunity/blog-sample/blob/main/vertx4-transformer/src/main/java/org/baichuan/example/vertx/transformer/VertxFutureTransformer.java)。

---
#### 关于类加载
由于**参与修改**的**所有类**都是由**`appClassLoader`**加载的，所以不会出现什么问题。但是，如果我们要按照上述设计对**jdk自带(jre/lib)的一些类**进行修改呢？比如说实现`ThreadLocal`在`ThreadPoolExecutor#execute`中的传递，思路似乎没多大区别，无非就是对传入`ThreadPoolExecutor#execute`中的`Runnable`做一层包装（设该包装类为**类A**）。然后当我们运行是却会发现每次执行`execute`方法时都会得到一个`NoClassDefFoundException`，无法找到**类A**。

这是为什么呢？明明**类A**对应的`class`文件是**存在的**(build目录下)，但虚拟机为什么在执行`execute`方法时找不到它呢？

这是因为`ThreadPoolExecutor`这个类是由`BootStrapClassLoader`加载的，而正常情况下类A并不处于`BootStrapClassLoader`的查找范围之中，所以就引发了这个异常。概览如下：

- 在虚拟机第一次执行到`execute`方法中我们修改过的代码时，此时类A在此处仅仅是一个符号引用，这时必然会请求虚拟机去[解析](http://hg.openjdk.java.net/jdk8/jdk8/hotspot/file/87ee5ee27509/src/share/vm/oops/constantPool.cpp#l180)这个符号引用。这里会去根据[加载ThreadPoolExecutor的类加载器](http://hg.openjdk.java.net/jdk8/jdk8/hotspot/file/87ee5ee27509/src/share/vm/oops/constantPool.cpp#l212)(`BootStrapClassLoader`)以及**类A**的类名在内存中[全局查找这个类](http://hg.openjdk.java.net/jdk8/jdk8/hotspot/file/87ee5ee27509/src/share/vm/classfile/systemDictionary.cpp#l616)，查找不到则会尝试[加载这个类](http://hg.openjdk.java.net/jdk8/jdk8/hotspot/file/87ee5ee27509/src/share/vm/classfile/systemDictionary.cpp#l1289)，如果这两个过程都找不到对应的类，就会抛出上述异常。

像alibaba的[`TransmittableThreadLocal`](https://github.com/alibaba/transmittable-thread-local) 是需要修改rt.jar中的类的(比如`ThreadPoolExecutor`)，这些核心类都是由BootstrapClassloader加载的。但是我们引进来的[`TransmittableThreadLocal`](https://github.com/alibaba/transmittable-thread-local) 默认由AppClassLoader加载，这势必会导致在重新加载被修改的由class时抛出NoClassDefFoundException。所以[`TransmittableThreadLocal`](https://github.com/alibaba/transmittable-thread-local) 中**参与核心类库修改的类必须要被添加到bootClassPath中**(由`BootstrapClassLoader`加载)。

### 2. 基于netty的异步io操作

vertx的io操作基于netty，netty的io多路复用基于java nio，nio只能说是非阻塞式io。但是netty提供给上层应用程序的io操作确实异步的。netty会不停的轮询就绪的io事件，然后把vertx感兴趣的事件包装好通知到vertx（比如有数据可读的时候），最后vertx再通知到我们的业务层。

其实这里的实现思路是一样的，就不赘述了。简单点就是在往vertx中塞回调时对这个回调进行上述包装即可。

---
# 总结
本文主要探讨了如何在基于vertx的异步环境中追踪一次完整的函数调用，以及实现过程中可能会碰到的问题。

上述内容的源码可在[我的github](https://github.com/scientificCommunity/blog-sample)上找到。
