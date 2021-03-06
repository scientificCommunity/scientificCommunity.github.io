---
title: 单元测试之浅析Mockito mock Kotlin Object类方法
abbrlink: 48796
date: 2021-09-12 23:38:56
tags:
  - 技术
  - 踩坑
categories: 技术
description: Kotlin里有一种object类型的类，它在使用上跟Java里的静态类很相似。事实上，它们编译后确实很相似，只不过Kotlin在语法层面上隐藏了一些实现细节，这些细节如果不清楚的话往往会引发一些意料之外的错误...
---
`Kotlin`里有一种`object`类型的类，它在使用上跟`Java`里的静态类很相似。事实上，它们编译后确实很相似，只不过`Kotlin`在语法层面上隐藏了一些实现细节，这些细节如果不清楚的话往往会引发一些意料之外的错误。
`Mockito`是可以直接`mock`静态方法的，而`Mockito`在`mock`这种`Kotlin`类里定义的"静态方法"时却会直接报错，为什么呢？

比如我创建一个`Kotlin` `Object`类：`ObjectMethod`

```kotlin
package com.baichuan.example.unit_test

object ObjectMethod {

    fun doSomething() {
        println("this is ObjectMethod#doSomething")
    }

    @JvmStatic
    fun doSomethingWithJvmStatic() {
        println("this is ObjectMethod#doSomethingWithJvmStatic")
    }
}
```

如果我直接去`mock`该类的`doSomething`方法，会报错。

```kotlin
  @Test
  @DisplayName("mock普通的kotlin静态方法")
  fun testMockKotlinObject() {
      Assertions.assertThrows(MissingMethodInvocationException::class.java) {
          Mockito.mockStatic(ObjectMethod::class.java).`when`<Unit>(
              ObjectMethod::doSomething
          ).thenAnswer { println("this is mocked Object#doSomething") }
      }

      ObjectMethod.doSomething()
  }
```

这是因为`kotlin`里的`object`类里的方法虽然在`kotlin`里从形态跟使用上来看与静态方法无二。但是编译成`java`代码后，其本质其实是内部初始化了一个当前类的静态常量实例`INSTANCE`。这个`INSTANCE`在`kotlin`语法里被隐藏了，但在java里依然可以显示访问。`ObjectMethod`编译成`java`后的代码如下：

```java
public final class ObjectMethod {
   @NotNull
   public static final ObjectMethod INSTANCE = new ObjectMethod();

   private ObjectMethod() {
   }

   public final void doSomething() {
      String var1 = "this is ObjectMethod#doSomething";
      boolean var2 = false;
      System.out.println(var1);
   }

   @JvmStatic
   public static final void doSomethingWithJvmStatic() {
      String var0 = "this is ObjectMethod#doSomethingWithJvmStatic";
      boolean var1 = false;
      System.out.println(var0);
   }
}
```

所以，不能`mock` `ObjectMethod#doSomething`本质上的原因是正常手段无法`mock`静态常量。如果想要使`kotlin`的`object`类中的方法能够被`mock`，只需在方法上加上`@JvmStatic`注解即可。被其标注的方法会被编译成普通的`java`静态方法。

上面说正常手段无法mock静态常量，那么非正常手段呢？其实这个非正常手段就是通过反射将被`mock`过的实例注入到`ObjectMethod`中即可。

```kotlin
	@Test
	@DisplayName("通过反射修改静态常量来mock普通的kotlin静态方法")
	fun testMockKotlinObjectMethodByReflection() {
	    val mock = Mockito.mock(ObjectMethod::class.java)
	    Mockito.`when`(mock.doSomething()).then {
	        print("this is mocked ObjectMethod by reflection")
	    }
	    val declaredMethod = ObjectMethod::class.java.getDeclaredField("INSTANCE")
	    ReflectionUtils.setFinalStatic(declaredMethod, mock)
	
	    ObjectMethod.doSomething()
	}
```

`ReflectionUtils`

```kotlin
package com.baichuan.example.unit_test

import java.lang.reflect.Field
import java.lang.reflect.Modifier

object ReflectionUtils {
    @Throws(Exception::class)
    fun setFinalStatic(field: Field, newValue: Any) {
        field.isAccessible = true
        val modifiersField: Field = Field::class.java.getDeclaredField("modifiers")
        modifiersField.isAccessible = true
        modifiersField.setInt(field, field.modifiers and Modifier.FINAL.inv())
        field.set(null, newValue)
    }
}
```
## [github](https://github.com/scientificCommunity/blog-sample/tree/main/unit-test-sample)

