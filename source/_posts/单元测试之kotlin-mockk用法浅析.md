---
title: 单元测试之kotlin mockk用法浅析
tags:
  - 技术
  - unit test
  - 浅析
categories: 技术
description: 如何使用kotlin mockk?...
abbrlink: a1887a80
date: 2020-11-18 17:59:26
---
## 本例用到的类定义
```java
@Slf4j
public class ServiceImplA implements Service {

    @Override
    public void doSomething1(String s) {
        log.info("input is:{}", s);
    }

    @Override
    public String doSomething2(String s) {
        log.info("doSomething2,input:{}", s);
        return s;
    }
}
```
## PS
文中会出现一个定义：`可mock状态`

通过mockk<>(),mockkObject(),spyk()返回的对象就处于mock状态。只有处于这个状态的对象才能通过every对对象的行为进行Mock
## mockk<T>()
- mock类T并返回该类的mock对象

这个方法返回T的实例，该实例所有函数都为`待mock状态`，这些待mock状态的函数都==不能直接调用==，需要结合every{}mock对应方法后才能调用
```java
    //返回ServiceImplA一个mock对象
    val mockk = mockk<ServiceImplA>()
    //mock指定方法
    every { mockk.doSomething1(any()) } returns Unit
    //调用被mock的方法
    mockk.doSomething1("")
    //该方法未通过every进行mock，会报错
    mockk.doSomething2("")
```
## mockkObject()
- 将指定对象转为可mock状态

与mockk<>()的区别是返回的mock对象，允许mock行为跟真实行为并存，如果不主动mock，则执行真实行为
```java
    val serviceImplA = ServiceImplA()
    mockkObject(serviceImplA)
    every { serviceImplA.doSomething1(any()) } returns Unit
    //调用被mock方法
    serviceImplA.doSomething1("sfas")
    //调用真实方法
    serviceImplA.doSomething2("sfas")
```
## spyk<T>() & spyk(T obj)
- 返回T的spyk对象或者obj的spyk对象
- 与mockk<>()的区别是，spyk<>()返回的对象是允许**真实行为跟mock行为共存的**，其表现跟mockkObject()相似
```java
    //返回ServiceImplA的一个spyk对象
    val spyk = spyk<ServiceImplA>()
    every { spyk.doSomething1(any()) } returns Unit
    //调用mock方法
    spyk.doSomething1("123")
    //调用真实方法
    spyk.doSomething2("999")

    val serviceImplA = ServiceImplA()
    //返回serviceImplA对象被spyk后的对象，原对象不会改变
    val spyk1 = spyk(serviceImplA)
    //serviceImplA不是可mock状态，这里会报错
    //every { serviceImplA.doSomething1(any()) } returns Unit

    //mock
    every { spyk1.doSomething1(any()) } returns Unit
    //同上
    spyk1.doSomething1("999")
    spyk1.doSomething2("999")
```
## every{...} ...
- 定义mock行为

### returns
作用是定制mock行为的结果
```java
    val spyk = spyk<ServiceImplA>()
    //mock doSomething2,无论什么输入都返回111
    every { spyk.doSomething2(any()) } returns "111"

    val input = "222"
    //这里拿到的应该是111
    val mockkResult = spyk.doSomething2(input)
    println("mockk行为结果:$mockkResult")

    val real = ServiceImplA()
    //这里拿到的应该是222
    val realResult = real.doSomething2(input)
    println("mockk行为结果:$realResult")
```
---
有时候我们可能需要在mock行为里做一些运算而不仅仅只是定制一个结果，这个时候就需要answers
### answers
```java
    val input = "222"
    val spyk = spyk<ServiceImplA>()
    //定制mock行为
    every { spyk.doSomething2(any()) } answers {
        //something will happen
        println("定制mock行为")

        //拿到真实函数信息
        val originalMethod = invocation.originalCall

        //调用真实行为并拿到响应结果
        val originalResult = callOriginal()
        //同上
        val originalResult1 = originalMethod.invoke()
        
        //返回一个固定结果
        "mock result"
    }
    //调用会执行answers里代码
    spyk.doSomething2(input)

    every { spyk.doSomething2(any()) } propertyType String::class answers {
        //拿到第一个输入参数
        val firstArg = firstArg<String>()
        println("输入：$firstArg")
        println("这里是mock后的行为")

        //定制方法返回
        "mock响应$firstArg"
    }
    spyk.doSomething2(input)
```
### andthen
- 这个一般可以结合junit的@RepeatTest或者@ParameterizedTest+@ValueSource/@EnumSource一起使用
```java
    val input = "222"
    val spyk = spyk<ServiceImplA>()
    every { spyk.doSomething2(any()) } propertyType String::class answers {
        //拿到第一个输入参数
        val firstArg = firstArg<String>()
        println("第一次执行，输入：$firstArg")

        //定制方法返回
        "第一次执行mock响应$firstArg"
    } andThen {
        //拿到输入参数
        val firstArg = firstArg<String>()
        println("第二次执行，输入：$firstArg")

        //定制方法返回
        "第二次执行mock响应$firstArg"
    }
    spyk.doSomething2(input)
    spyk.doSomething2(input + input)

    //次数不会重制，会定位到最后一个mock行为
    spyk.doSomething2(input)
```
### andthenThrow
```java
    val input1 = "222"
    val input2 = "222111"
    val spyk = spyk<ServiceImplA>()
    every { spyk.doSomething3(any(), any()) } propertyType String::class answers {
        //拿到第一个输入参数
        val firstArg = firstArg<String>()
        println("第一次执行，输入：$firstArg")

        //定制方法返回
        "第一次执行mock响应$firstArg"
    } andThen {
        //拿到输入参数
        val firstArg = firstArg<String>()
        println("第二次执行，输入：$firstArg")

        //定制方法返回
        "第二次执行mock响应$firstArg"
    } andThenThrows (RuntimeException())
    spyk.doSomething3(input1, input2)
    spyk.doSomething3(input1 + input1, input2 + input2)

    //第三次抛出RuntimeException
    spyk.doSomething3(input1, input2)
```
### AndThenAnswer
- 可以添加Answer接口的实例
```java
    val spyk = spyk<ServiceImplA>()
    //定义函数mock行为
    val functionAnswer = FunctionAnswer {
        println("functionAnswer")
        ""
    }
    //定义异常mock行为，返回一个运行时异常
    val throwingAnswer = ThrowingAnswer(RuntimeException())
    //定义多个行为处理集合，按添加顺序触发
    val manyAnswersAnswer = ManyAnswersAnswer(listOf(functionAnswer, throwingAnswer))
    //mock
    every { spyk.doSomething2(any()) } returns "" andThenAnswer (functionAnswer
            ) andThenAnswer (throwingAnswer
            ) andThenAnswer (manyAnswersAnswer
            //构造了两个ConstantAnswer组成一个ManyAnswersAnswer对象
            //listOf里输入的每个元素会最终赋值到ConstantAnswer的answer方法调用上
            //如果这里传入的是字符串，则代表这个answer就仅仅是返回这个字符串
            //这里的泛型对应里spyk.doSomething2()的返回参数类型
            ) andThenMany (listOf("functionAnswer", "throwingAnswer"))

    //第一次执行进入到returns ""
    spyk.doSomething2("1")
    //进入functionAnswer
    spyk.doSomething2("2")
    try {
        //第三次进入throwingAnswer抛出运行时异常
        spyk.doSomething2("3")
    } catch (e: RuntimeException) {
        println("第三次执行抛出运行时异常")
    }
    //进入manyAnswersAnswer中的functionAnswer
    spyk.doSomething2("4")

    try {
        //进入manyAnswersAnswer中的throwingAnswer
        spyk.doSomething2("5")
    } catch (e: RuntimeException) {
        println("第5次执行抛出运行时异常")
    }
    //将返回functionAnswer
    println("第6此调用返回：${spyk.doSomething2("6")}")
    spyk.doSomething2("7")
```
