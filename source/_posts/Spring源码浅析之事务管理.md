---
title: Spring源码浅析之事物管理
tags:
  - spring
  - 源码
categories: 技术
abbrlink: 992afad8
date: 2020-07-16 18:13:20
---

# 思考

 -  **spring是怎样帮助我们进行事务管理的**
 -  **spring是如何实现事务的传播的**

# 概览

spring声明式事务需要aop的支持，在spring容器初始化的时候，会将一个TransactionInterceptor的实例注入到所有方法上加了@Transactional注解的bean的代理对象的advisor数组中，当我们执行事务方法时，就会去执行TransactionInterceptor.invoke方法进行事务处理

# TransactionInterceptor
## 注入TransactionInterceptor的过程参考

1\. 首先初始化所有Advisor，这个过程会把容器中实现了advisor接口的beanDefinition对应的类实例化并加入到一个AdvisedSupport对象中，最后会注入到代理对象
```java
        AbstractAutoProxyCreator.postProcessBeforeInstantiation()

            --->AspectJAwareAdvisorAutoProxyCreator.shouldSkip()

               --->AspectJAwareAdvisorAutoProxyCreator.findCandidateAdvisors() 
```
2\. 代理bean
```java
       AbstractAutoProxyCreator.postProcessAfterInitialization()

            -->AbstractAutoProxyCreator.wrapIfNecessary()
	               //这里面会去选择使用jdk或者cglib进行代理对象的创建
                -->AbstractAutoProxyCreator.createProxy()
```
                
## TransactionInterceptor类图
![TransactionInterceptor类图.png](https://imgconvert.csdnimg.cn/aHR0cHM6Ly91cGxvYWQtaW1hZ2VzLmppYW5zaHUuaW8vdXBsb2FkX2ltYWdlcy8xNDMwOTUzOC0xZDkwNmIxNjgwMGVhOGExLnBuZw?x-oss-process=image/format,png)
这里可以到到TransactionInterceptor最终是实现了Avice接口，所以在前面的1中就会把TransactionInterceptor实例化好作为拦截器注入到代理对象中

# 事务处理流程
## 全局
### invokeWithinTransaction()
当我们调用加了@Transactional的bean的目标方法时，首先会进入TransactionInterceptor.invoke，这里是因为TransactionInterceptor实现了MethodInterceptor（具体可参考spring aop原理）。然后会调用TransactionAspectSupport.invokeWithinTransaction()
```java
    @Nullable
    protected Object invokeWithinTransaction(Method method, @Nullable Class<?> targetClass,
            final InvocationCallback invocation) throws Throwable {
            
        TransactionAttributeSource tas = getTransactionAttributeSource();
        final TransactionAttribute txAttr = (tas != null ? tas.getTransactionAttribute(method, targetClass) : null);
        final PlatformTransactionManager tm = determineTransactionManager(txAttr);
        final String joinpointIdentification = methodIdentification(method, targetClass, txAttr);

        if (txAttr == null || !(tm instanceof CallbackPreferringPlatformTransactionManager)) {
            // Standard transaction demarcation with getTransaction and commit/rollback calls.
            //初始化事务所需要的所有信息到txInfo，包括隔离级别，数据源等
            TransactionInfo txInfo = createTransactionIfNecessary(tm, txAttr, joinpointIdentification);
            Object retVal = null;
            try {
                //继续执行后续的拦截器，最终返回目标方法执行结果
                retVal = invocation.proceedWithInvocation();
            }
            catch (Throwable ex) {
                //异常回滚
                completeTransactionAfterThrowing(txInfo, ex);
                throw ex;
            }
            finally {
            	//清除线程本地变量保存的事务信息
                cleanupTransactionInfo(txInfo);
            }
            //无异常则commit
            commitTransactionAfterReturning(txInfo);
            return retVal;
        }
```
## 开启事务管理
### createTransactionIfNecessary()
这里有个createTransactionIfNecessary(tm, txAttr, joinpointIdentification)方法，它保存了事务执行过程中所需要的全部信息，其内部会处理事务的传播，例如当propagation设置为REQUIRES_NEW时，它会去挂起当前事务，挂起主要是把当前事务的jdbc连接从线程的threadlocalMap中清除，并保存到新的事务的TransactionStatus中。然后把当前事务的transactionInfo保存到新建立的transactioninfo的oldTransactionInfo属性中
```java
protected TransactionInfo createTransactionIfNecessary(@Nullable PlatformTransactionManager tm,
			@Nullable TransactionAttribute txAttr, final String joinpointIdentification) {

		// If no name specified, apply method identification as transaction name.
		if (txAttr != null && txAttr.getName() == null) {
			txAttr = new DelegatingTransactionAttribute(txAttr) {
				@Override
				public String getName() {
					return joinpointIdentification;
				}
			};
		}

		TransactionStatus status = null;
		if (txAttr != null) {
			if (tm != null) {
                //初始化事务的状态，后续提交跟回滚时会通过这个对象拿到这个事务的传播属性
               //处理事务的传播属性
				status = tm.getTransaction(txAttr);
			}
		}
        //初始化当前事务，并把当前事务加入到当前线程的threadLocalMap中
        //将先前的事务加入到当前事务的oldTransactionInfo属性中
		return prepareTransactionInfo(tm, txAttr, joinpointIdentification, status);
	}
```
进入tm.getTransaction()
```java
@Override
	public final TransactionStatus getTransaction(@Nullable TransactionDefinition definition) throws TransactionException {
        //获取当前线程绑定的transactionResource对象
		Object transaction = doGetTransaction();

		boolean debugEnabled = logger.isDebugEnabled();

		if (definition == null) {
			definition = new DefaultTransactionDefinition();
		}

         //如果当前已经存在一个事务
		if (isExistingTransaction(transaction)) {
            //处理事务的传播性
			return handleExistingTransaction(definition, transaction, debugEnabled);
		}
		if (definition.getPropagationBehavior() == TransactionDefinition.PROPAGATION_MANDATORY) {
			throw new IllegalTransactionStateException(
					"No existing transaction found for transaction marked with propagation 'mandatory'");
		}
		else if (definition.getPropagationBehavior() == TransactionDefinition.PROPAGATION_REQUIRED ||
				definition.getPropagationBehavior() == TransactionDefinition.PROPAGATION_REQUIRES_NEW ||
				definition.getPropagationBehavior() == TransactionDefinition.PROPAGATION_NESTED) {
			SuspendedResourcesHolder suspendedResources = suspend(null);
			if (debugEnabled) {
				logger.debug("Creating new transaction with name [" + definition.getName() + "]: " + definition);
			}
			try {
				boolean newSynchronization = (getTransactionSynchronization() != SYNCHRONIZATION_NEVER);
				DefaultTransactionStatus status = newTransactionStatus(
						definition, transaction, true, newSynchronization, debugEnabled, suspendedResources);
                //为当前session设置隔离级别，关闭自动提交
				doBegin(transaction, definition);
				prepareSynchronization(status, definition);
				return status;
			}
			catch (RuntimeException | Error ex) {
				resume(null, suspendedResources);
				throw ex;
			}
		}
		else {
			// Create "empty" transaction: no actual transaction, but potentially synchronization.
			if (definition.getIsolationLevel() != TransactionDefinition.ISOLATION_DEFAULT && logger.isWarnEnabled()) {
				logger.warn("Custom isolation level specified but no actual transaction initiated; " +
						"isolation level will effectively be ignored: " + definition);
			}
			boolean newSynchronization = (getTransactionSynchronization() == SYNCHRONIZATION_ALWAYS);
            //构建transcationStatus对象
			return prepareTransactionStatus(definition, null, true, newSynchronization, debugEnabled, null);
		}
	}
```
## 事务挂起
```java
	@Nullable
	protected final SuspendedResourcesHolder suspend(@Nullable Object transaction) throws TransactionException {
		if (TransactionSynchronizationManager.isSynchronizationActive()) {
			List<TransactionSynchronization> suspendedSynchronizations = doSuspendSynchronization();
			try {
				Object suspendedResources = null;
				if (transaction != null) {
					//把transaction中旧的连接信息包装返回，然后置空
					suspendedResources = doSuspend(transaction);
				}
				String name = TransactionSynchronizationManager.getCurrentTransactionName();
				TransactionSynchronizationManager.setCurrentTransactionName(null);
				boolean readOnly = TransactionSynchronizationManager.isCurrentTransactionReadOnly();
				TransactionSynchronizationManager.setCurrentTransactionReadOnly(false);
				Integer isolationLevel = TransactionSynchronizationManager.getCurrentTransactionIsolationLevel();
				TransactionSynchronizationManager.setCurrentTransactionIsolationLevel(null);
				boolean wasActive = TransactionSynchronizationManager.isActualTransactionActive();
				TransactionSynchronizationManager.setActualTransactionActive(false);
				//返回被挂起的连接信息
				return new SuspendedResourcesHolder(
						suspendedResources, suspendedSynchronizations, name, readOnly, isolationLevel, wasActive);
			}
			catch (RuntimeException | Error ex) {
				// doSuspend failed - original transaction is still active...
				doResumeSynchronization(suspendedSynchronizations);
				throw ex;
			}
		}
		else if (transaction != null) {
			// Transaction active but no synchronization active.
			Object suspendedResources = doSuspend(transaction);
			return new SuspendedResourcesHolder(suspendedResources);
		}
		else {
			// Neither transaction nor synchronization active.
			return null;
		}
	}
```
把旧的连接信息保存起来，并把当前transaction对象中的连接信息置空
## commit
```java
	@Override
	public final void commit(TransactionStatus status) throws TransactionException {
		//防止重复提交事务
		if (status.isCompleted()) {
			throw new IllegalTransactionStateException(
					"Transaction is already completed - do not call commit or rollback more than once per transaction");
		}

		DefaultTransactionStatus defStatus = (DefaultTransactionStatus) status;

		//调用TransactionStatus.setRollbackOnly()会进入这个处理
		if (defStatus.isLocalRollbackOnly()) {
			if (defStatus.isDebug()) {
				logger.debug("Transactional code has requested rollback");
			}
			processRollback(defStatus, false);
			return;
		}
		//像内部REQUIRED的方法抛出异常回滚，会设置ResourceHolderSupport.rollbackOnly为true，
		//如果外部事务方法catch这个异常
		//外部方法就会尝试提交事务并最终走到这
		if (!shouldCommitOnGlobalRollbackOnly() && defStatus.isGlobalRollbackOnly()) {
			if (defStatus.isDebug()) {
				logger.debug("Global transaction is marked as rollback-only but transactional code requested commit");
			}
			processRollback(defStatus, true);
			return;
		}

		processCommit(defStatus);
	}
	
	private void processCommit(DefaultTransactionStatus status) throws TransactionException {
		try {
			boolean beforeCompletionInvoked = false;

			boolean unexpectedRollback = false;
			beforeCompletionInvoked = true;

			if (status.hasSavepoint()) {
				if (status.isDebug()) {
					logger.debug("Releasing transaction savepoint");
				}
				unexpectedRollback = status.isGlobalRollbackOnly();
				//删除savepoint
				status.releaseHeldSavepoint();
			}
			//像REQURED传播性，这个值就为false，
			//保证了内部RUQUIRED方法不会触发事务提交
			else if (status.isNewTransaction()) {
				if (status.isDebug()) {
					logger.debug("Initiating transaction commit");
				}
				unexpectedRollback = status.isGlobalRollbackOnly();
				//提交事务
				doCommit(status);
			}
			else if (isFailEarlyOnGlobalRollbackOnly()) {
				unexpectedRollback = status.isGlobalRollbackOnly();
				}
		}
		finally {
			//还原当前session，
			//把之前被挂起的连接信息重新设置到当前线程的threadLocalMap中
			cleanupAfterCompletion(status);
		}
	}
```
如果业务方法没有抛出异常，最终会调用commit
## Rollback
```java
	private void processRollback(DefaultTransactionStatus status, boolean unexpected) {
		try {
			boolean unexpectedRollback = unexpected;

			try {
				triggerBeforeCompletion(status);

				if (status.hasSavepoint()) {
					if (status.isDebug()) {
						logger.debug("Rolling back transaction to savepoint");
					}
					//回滚事务至savepoint并清除savepoint
					status.rollbackToHeldSavepoint();
				}
				else if (status.isNewTransaction()) {
					if (status.isDebug()) {
						logger.debug("Initiating transaction rollback");
					}

					doRollback(status);
				}
				//如果传播级别是RUQUIRED
				else {
					// Participating in larger transaction
					if (status.hasTransaction()) {
						if (status.isLocalRollbackOnly() || isGlobalRollbackOnParticipationFailure()) {
							if (status.isDebug()) {
								logger.debug("Participating transaction failed - marking existing transaction as rollback-only");
							}
							//设置状态，commit的时候rollbackOnly为true会触发回滚
							doSetRollbackOnly(status);
						}
						else {
							if (status.isDebug()) {
								logger.debug("Participating transaction failed - letting transaction originator decide on rollback");
							}
						}
					}
					else {
						logger.debug("Should roll back transaction but cannot - no transaction available");
					}
					
					if (!isFailEarlyOnGlobalRollbackOnly()) {
						unexpectedRollback = false;
					}
				}
			}
			catch (RuntimeException | Error ex) {
				triggerAfterCompletion(status, TransactionSynchronization.STATUS_UNKNOWN);
				throw ex;
			}
		}
		finally {
			cleanupAfterCompletion(status);
		}
	}
```
这里我们会发现一个小细节，当外部带事务的方法调用了传播性为REQUIRED的内部方法，如果内部方法抛异常了，这个时候内部方法的事务管理在catch到异常之后，只会设置一个回滚标志位，等到外部方法去提交时，再出发回滚
## TransactionStatus.isNewTransaction
这个值很重要，直接决定了事务能否提交与回滚，REQUIRED,SUPPORTS,NESTED就需要依赖这个来实现传播
## finally处理--cleanupTransactionInfo
最后执行完目标方法回到invokeWithinTransaction，我们来看看finally里的cleanupTransactionInfo()做了什么事情
```java
    protected void cleanupTransactionInfo(@Nullable TransactionInfo txInfo) {
		if (txInfo != null) {
			txInfo.restoreThreadLocalStatus();
		}
	}

    private void restoreThreadLocalStatus() {
			// Use stack to restore old transaction TransactionInfo.
			// Will be null if none was set.
			transactionInfoHolder.set(this.oldTransactionInfo);
	}
private static final ThreadLocal<TransactionInfo> transactionInfoHolder =
			new NamedThreadLocal<>("Current aspect-driven transaction");
```
这里我们发现，它把先前内层事务（如果存在）保存下来的事务信息重新设置到了当前线程的threadlocalMap中，这里主要在TransactionAspectSupport.currentTransactionStatus()可以获取到这个transactionInfo的status属性

# 传播属性
代码段来自AbstractPlatformTransactionManager类的getTransaction  &handleExistingTransaction()
## 核心源码预览
```java
	@Override
	public final TransactionStatus getTransaction(@Nullable TransactionDefinition definition) throws TransactionException {
		//如果当前不存在事务，且传播属性是这些，就开启一个新的事务
		//否则啥都不做
		if (definition.getPropagationBehavior() == TransactionDefinition.PROPAGATION_REQUIRED ||
				definition.getPropagationBehavior() == TransactionDefinition.PROPAGATION_REQUIRES_NEW ||
				definition.getPropagationBehavior() == TransactionDefinition.PROPAGATION_NESTED) {
			SuspendedResourcesHolder suspendedResources = suspend(null);
			if (debugEnabled) {
				logger.debug("Creating new transaction with name [" + definition.getName() + "]: " + definition);
			}
			try {
				boolean newSynchronization = (getTransactionSynchronization() != SYNCHRONIZATION_NEVER);
				DefaultTransactionStatus status = newTransactionStatus(
						definition, transaction, true, newSynchronization, debugEnabled, suspendedResources);
				doBegin(transaction, definition);
				prepareSynchronization(status, definition);
				return status;
			}
			catch (RuntimeException | Error ex) {
				resume(null, suspendedResources);
				throw ex;
			}
		}
		else {
			// Create "empty" transaction: no actual transaction, but potentially synchronization.
			if (definition.getIsolationLevel() != TransactionDefinition.ISOLATION_DEFAULT && logger.isWarnEnabled()) {
				logger.warn("Custom isolation level specified but no actual transaction initiated; " +
						"isolation level will effectively be ignored: " + definition);
			}
			boolean newSynchronization = (getTransactionSynchronization() == SYNCHRONIZATION_ALWAYS);
			return prepareTransactionStatus(definition, null, true, newSynchronization, debugEnabled, null);
		}
	}
	private TransactionStatus handleExistingTransaction(
			TransactionDefinition definition, Object transaction, boolean debugEnabled)
			throws TransactionException {
			//如果当前存在事务，newSynchronization设置为false
			boolean newSynchronization = (getTransactionSynchronization() != SYNCHRONIZATION_NEVER);
			return prepareTransactionStatus(definition, transaction, false, newSynchronization, debugEnabled, null);
	}
```
## NEVER
```java
if (definition.getPropagationBehavior() == TransactionDefinition.PROPAGATION_NEVER) {
			throw new IllegalTransactionStateException(
					"Existing transaction found for transaction marked with propagation 'never'");
		}
```
进入handleExistingTransaction的条件是当前已经存在一个事务，所以这里可以看出，NERVER不能运行在一个已经存在的事务里，同时在getTransaction()方法内不会去关闭事务的自动提交，这就意味着spring==不会帮我们去控制事务的提交与回滚==
## NOT_SUPPORTED
```java
		if (definition.getPropagationBehavior() == TransactionDefinition.PROPAGATION_NOT_SUPPORTED) {
			if (debugEnabled) {
				logger.debug("Suspending current transaction");
			}
			//挂起已存在的事务
			Object suspendedResources = suspend(transaction);
			boolean newSynchronization = (getTransactionSynchronization() == SYNCHRONIZATION_ALWAYS);
			//第三个参数为false，控制了spring后面不会去调用真正的事务提交方法
			//可参考AbstractPlatformTransactionManager#741行
			return prepareTransactionStatus(
					definition, null, false, newSynchronization, debugEnabled, suspendedResources);
		}
```
所以我们可以知道，NOT_SUPPORTED就是说，如果当前方法已经存在一个事务中，就会挂起当前事务，无论如何，被这个标注的方法，spring都不会去进行事务管理，但是，它与NERVER的区别是，不会抛出异常
挂起主要是保存当前事务的jdbc连接信息到TranscationStatus中
把当前线程的threadlocalMap里的连接信息切换成新的连接信息
## REQUIRES_NEW
```java
		if (definition.getPropagationBehavior() == TransactionDefinition.PROPAGATION_REQUIRES_NEW) {
			if (debugEnabled) {
				logger.debug("Suspending current transaction, creating new transaction with name [" +
						definition.getName() + "]");
			}
			//挂起已存在的事务
			SuspendedResourcesHolder suspendedResources = suspend(transaction);
			try {
				boolean newSynchronization = (getTransactionSynchronization() != SYNCHRONIZATION_NEVER);
				//参数3为true意味着对应的事务可用自主提交
				DefaultTransactionStatus status = newTransactionStatus(
						definition, transaction, true, newSynchronization, debugEnabled, suspendedResources);
				//拿到新的连接，设置隔离级别，关闭自动提交
				doBegin(transaction, definition);
				prepareSynchronization(status, definition);
				return status;
			}
			catch (RuntimeException | Error beginEx) {
				resumeAfterBeginException(transaction, suspendedResources, beginEx);
				throw beginEx;
			}
		}
```
如果当前已存在事务，则挂起当前事务，开启一个新的事务

## NESTED
```java
		if (definition.getPropagationBehavior() == TransactionDefinition.PROPAGATION_NESTED) {
			//是否通过安全点实现嵌套事务，默认是
			if (useSavepointForNestedTransaction()) {
				//没有挂起当前事务，说明当前方法跟外层方法在同一个session里
				//第3个参数为false意味着当前方法最后不会触发事务的全局commit跟rollback
				DefaultTransactionStatus status =
						prepareTransactionStatus(definition, transaction, false, false, debugEnabled, null);
				//创建一个savepoint，如果后面业务出异常，(mysql语法：savepoint + name)
				//spring会自动帮助我们把事务回滚到这个savepoint
				status.createAndHoldSavepoint();
				return status;
			}
			//如果不使用savepoint，就通过内部加嵌套的begin跟commit/rollback
			else {
				boolean newSynchronization = (getTransactionSynchronization() != SYNCHRONIZATION_NEVER);
				DefaultTransactionStatus status = newTransactionStatus(
						definition, transaction, true, newSynchronization, debugEnabled, null);
				doBegin(transaction, definition);
				prepareSynchronization(status, definition);
				return status;
			}
		}
		//回滚处理
		private void processRollback(DefaultTransactionStatus status, boolean unexpected) {
		try {
			boolean unexpectedRollback = unexpected;

			try {
				triggerBeforeCompletion(status);
				//如果有savepoint
				if (status.hasSavepoint()) {
					if (status.isDebug()) {
						logger.debug("Rolling back transaction to savepoint");
					}
					//事务回滚至savepoint
					status.rollbackToHeldSavepoint();
				}
				else if (status.isNewTransaction()) {
					if (status.isDebug()) {
						logger.debug("Initiating transaction rollback");
					}
					doRollback(status);
				}
			}
		}
	private void processCommit(DefaultTransactionStatus status) throws TransactionException {
		try {
			boolean beforeCompletionInvoked = false;

			try {
				boolean unexpectedRollback = false;
				prepareForCommit(status);
				triggerBeforeCommit(status);
				triggerBeforeCompletion(status);
				beforeCompletionInvoked = true;
				
				if (status.hasSavepoint()) {
					if (status.isDebug()) {
						logger.debug("Releasing transaction savepoint");
					}
					unexpectedRollback = status.isGlobalRollbackOnly();
					//删除savepoint
					status.releaseHeldSavepoint();
				}
				else if (status.isNewTransaction()) {
					if (status.isDebug()) {
						logger.debug("Initiating transaction commit");
					}
					unexpectedRollback = status.isGlobalRollbackOnly();
					doCommit(status);
				}
```
这里可以看到，嵌套事务利用了savepoint，内部事务不会commit，如果发生异常，只会把事务rollback至创建的savepoint
## MANDATORY
```java
	@Override
	public final TransactionStatus getTransaction(@Nullable TransactionDefinition definition) throws TransactionException {
		if (isExistingTransaction(transaction)) {
			// Existing transaction found -> check propagation behavior to find out how to behave.
			return handleExistingTransaction(definition, transaction, debugEnabled);
		}
		if (definition.getPropagationBehavior() == TransactionDefinition.PROPAGATION_MANDATORY) {
			throw new IllegalTransactionStateException(
					"No existing transaction found for transaction marked with propagation 'mandatory'");
		}
```
这里很明显，如果当前方法没有运行在一个已存在的事务内，就会抛异常
## REQUIRED
## SUPPORTS
```java
		//当前不存在事务，并且传播机制是这几种
		else if (definition.getPropagationBehavior() == TransactionDefinition.PROPAGATION_REQUIRED ||
				definition.getPropagationBehavior() == TransactionDefinition.PROPAGATION_REQUIRES_NEW ||
				definition.getPropagationBehavior() == TransactionDefinition.PROPAGATION_NESTED) {
			SuspendedResourcesHolder suspendedResources = suspend(null);
			if (debugEnabled) {
				logger.debug("Creating new transaction with name [" + definition.getName() + "]: " + definition);
			}
			try {
				boolean newSynchronization = (getTransactionSynchronization() != SYNCHRONIZATION_NEVER);
				DefaultTransactionStatus status = newTransactionStatus(
						definition, transaction, true, newSynchronization, debugEnabled, suspendedResources);
				//开启事务管理
				doBegin(transaction, definition);
				prepareSynchronization(status, definition);
				return status;
			}
			catch (RuntimeException | Error ex) {
				resume(null, suspendedResources);
				throw ex;
			}
		}
		//不参与事务管理
		else {
			if (definition.getIsolationLevel() != TransactionDefinition.ISOLATION_DEFAULT && logger.isWarnEnabled()) {
			boolean newSynchronization = (getTransactionSynchronization() == SYNCHRONIZATION_ALWAYS);
			return prepareTransactionStatus(definition, null, true, newSynchronization, debugEnabled, null);
		}
```
这里可以看出，如果当前已存在事务，REQUIRED跟SUPPORTS的处理方式都是延用当前事务，但是如果当前不存在事务，REQUIRED会开启一个事务管理，SUPPORTS则不做任何处理，spring不介入事务处理

# 总结
Spring声明式事务通过AOP注入TranscationInterceptor生成代理对象来对目标方法进行拦截，通过关闭db事务的自动提交来介入事务管理，并在内部对事务的传播做了一系列的控制
