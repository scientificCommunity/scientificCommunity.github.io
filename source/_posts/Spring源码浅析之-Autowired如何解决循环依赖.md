---
title: Spring源码浅析之@Autowired如何解决循环依赖
tags:
  - 技术
  - 源码
  - spring
  - 浅析
categories: 技术
description: 通过Autowired注解，当spring ioc容器初始化时会帮我们从容器中拿到对应的实例进行注入
abbrlink: f0ea53d7
date: 2020-10-22 14:42:21
---
# @Autowired的what&how
在spring框架下，我们可以通过`@Autowired`注解对==属性==或者==方法参数==进行标注，当`spring ioc`容器初始化时，会帮我们从容器中拿到对应的实例进行注入
# 什么是循环依赖
假如现在有两个`Bean`如下所示

```java
public class BeanA {
    @Autowired
    private BeanB beanB;
}

public class BeanB {
    @Autowired
    private BeanA beanA;
}
```
然后我们通过`annotationConfigApplicationContext#register`将两个`bean`的信息注入到容器中，最后通过`refresh`进行容器到初始化操作
```java
public static void main(String[] args) {
        AnnotationConfigApplicationContext annotationConfigApplicationContext = new AnnotationConfigApplicationContext();
        annotationConfigApplicationContext.register(Bean1.class);
        annotationConfigApplicationContext.register(Bean2.class);
        annotationConfigApplicationContext.refresh();
    }
```
可以看到A跟B互相依赖，试着想象：当容器先初始化`beanA`时，必然要对属性beanB进行赋值，这个时候容器中还没有`beanB`，那么势必会触发`beanB`的初始化流程，而`beanB`初始化的完成也需要对属性`beanA`赋值，但`beanA`还未初始化完成，这里就产生了所谓的循环依赖。
# spring如何解决循环依赖
这里有一个很关键的属性：
```java
public class DefaultSingletonBeanRegistry extends SimpleAliasRegistry implements SingletonBeanRegistry {
	/** Cache of singleton factories: bean name to ObjectFactory. */
	private final Map<String, ObjectFactory<?>> singletonFactories = new HashMap<>(16);
}
```
key是beanName，value是一个对象工厂，我们点进去看一下
```java
public interface ObjectFactory<T> {

	T getObject() throws BeansException;

}
```
其实这里的getObject()就是最终解决循环依赖所调用的方法。
那么程序是怎样执行到这的呢？
我们先从bean的创建入手
如果容器还未实例化bean，那么就会走到这里
```java
protected Object doCreateBean(final String beanName, final RootBeanDefinition mbd, final @Nullable Object[] args)
			throws BeanCreationException {
		BeanWrapper instanceWrapper = null;
		if (instanceWrapper == null) {
			//实例化bean，如果@Autowired加在构造方法上，
			//那么就会在这里完成注入
			//因为下面的回调还未注册，所以这里无法解决循环依赖
			instanceWrapper = createBeanInstance(beanName, mbd, args);
		}
		
		final Object bean = instanceWrapper.getWrappedInstance();
		
		boolean earlySingletonExposure = (mbd.isSingleton() && this.allowCircularReferences &&
				isSingletonCurrentlyInCreation(beanName));
		if (earlySingletonExposure) {
			if (logger.isTraceEnabled()) {
				logger.trace("Eagerly caching bean '" + beanName +
						"' to allow for resolving potential circular references");
			}
			//往单例工厂(之前说的singletonFactories)中添加一个
			//ObjectFactory的匿名实现作为回调，
			addSingletonFactory(beanName, () -> getEarlyBeanReference(beanName, mbd, bean));
			
			//属性赋值，处理@Autowired(非构造方法)
			populateBean(beanName, mbd, instanceWrapper);
		}
```
这里我们发现，在实例化`bean`跟对属性赋值之间有一个`addSingletonFactory`的操作，作用是注册一个可以获取当前正在创建的`bean`的一个回调
```java
	protected void addSingletonFactory(String beanName, ObjectFactory<?> singletonFactory) {
		synchronized (this.singletonObjects) {
			if (!this.singletonObjects.containsKey(beanName)) {
				this.singletonFactories.put(beanName, singletonFactory);
			}
		}
	}
```

进入回调，发现回调默认返回的就是`bean`本身
```java	
	protected Object getEarlyBeanReference(String beanName, RootBeanDefinition mbd, Object bean) {
		Object exposedObject = bean;
		if (!mbd.isSynthetic() && hasInstantiationAwareBeanPostProcessors()) {
			for (BeanPostProcessor bp : getBeanPostProcessors()) {
				if (bp instanceof SmartInstantiationAwareBeanPostProcessor) {
					SmartInstantiationAwareBeanPostProcessor ibp = (SmartInstantiationAwareBeanPostProcessor) bp;
					exposedObject = ibp.getEarlyBeanReference(exposedObject, beanName);
				}
			}
		}
		return exposedObject;
	}
	
	default Object getEarlyBeanReference(Object bean, String beanName) throws BeansException {
		//	返回bean本身
		return bean;
	}
```

ok，这里得出一个结论，即使`bean`未初始化完成，`spring`也提供了方法来获取这个`bean`的实例。
如果应用到我们上面的栗子中来就是：

 1. `beanA`实例化完成
 2. 添加获取`beanA`的回调到`singletonFactories`
 3. 调用`populateBean`，处理`@Autowired`，注入`beanB`

因为`beanB`还未创建，那么势必会进入创建`beanB`的流程，当`beanB`也走到`populateBean`时，也需要完成`beanA`的注入，这时就会尝试从`beanFactory`中获取`beanA`，这里最终会进到
`AbstractBeanFactory`的`doGetBean`中
```java
	protected <T> T doGetBean(final String name, @Nullable final Class<T> requiredType,
			@Nullable final Object[] args, boolean typeCheckOnly) throws BeansException {

		final String beanName = transformedBeanName(name);
		Object bean;

		// Eagerly check singleton cache for manually registered singletons.
		Object sharedInstance = getSingleton(beanName);
	}
```
这里很关键，进入`getSingleton(beanName)`
```java
	public Object getSingleton(String beanName) {
		return getSingleton(beanName, true);
	}
	
	protected Object getSingleton(String beanName, boolean allowEarlyReference) {
		Object singletonObject = this.singletonObjects.get(beanName);
		if (singletonObject == null && isSingletonCurrentlyInCreation(beanName)) {
			synchronized (this.singletonObjects) {
				singletonObject = this.earlySingletonObjects.get(beanName);
				if (singletonObject == null && allowEarlyReference) {
					//拿到之前注册的单例工厂对象
					ObjectFactory<?> singletonFactory = this.singletonFactories.get(beanName);
					if (singletonFactory != null) {
					    //调用之前注册的回调
						singletonObject = singletonFactory.getObject();
						this.earlySingletonObjects.put(beanName, singletonObject);
						this.singletonFactories.remove(beanName);
					}
				}
			}
		}
		return singletonObject;
	}
```
当beanB走到这里时通过`beanA`的`beanName`获取`beanA`，首先会尝试从`singletonObjects`中获取，这里肯定获取不到，因为`singletonObjects`的`put`操作是在`bean`**初始化**完成之后。所以只能通过调用之前注册的回调`singletonFactory.getObject()`来获取`beanA`。
那么到此`beanA`注入到`beanB`的顺利完成，当`beanB`初始化完成之后，其实`beanA`的`getBean()`也就返回了`beanB`的引用，到此`beanA`也可以顺利完成依赖注入。
