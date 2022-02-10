---
title: seata源码分析之全局事务的开启跟xid的传递
tags:
  - seata
  - 源码
categories: 技术
abbrlink: b310611e
date: 2018-02-10 18:25:17
---
# 概览

### 首先我们通过@GlobalTransactional这个注解开启一个全局事务，而GlobalTransactionScanner.wrapIfNecessary()会为所有方法上加了这个注解的bean注入一个包装了GlobalTransactionalInterceptor实例的advisor，然后返回一个代理对象。GlobalTransactionalInterceptor会在该bean的方法调用前进行拦截，判断是否开启全局事务

上源码，关键位置我打了注释

```
@Override
protected Object wrapIfNecessary(Object bean, String beanName, Object cacheKey) {
    //判断全局事务是否启用
    if (disableGlobalTransaction) {
        return bean;
    }
    try {
        synchronized (PROXYED_SET) {
            if (PROXYED_SET.contains(beanName)) {
                return bean;
            }
            interceptor = null;
            //check TCC proxy
            if (TCCBeanParserUtils.isTccAutoProxy(bean, beanName, applicationContext)) {
                //TCC interceptor, proxy bean of sofa:reference/dubbo:reference, and LocalTCC
                interceptor = new TccActionInterceptor(TCCBeanParserUtils.getRemotingDesc(beanName));
            } else {
                Class<?> serviceInterface = SpringProxyUtils.findTargetClass(bean);
                Class<?>[] interfacesIfJdk = SpringProxyUtils.findInterfaces(bean);

                //判断bean里的方法上有没有@GlobalTransactional注解
                if (!existsAnnotation(new Class[]{serviceInterface})
                    && !existsAnnotation(interfacesIfJdk)) {
                    return bean;
                }

                if (interceptor == null) {
                    //初始化Interceptor,后面会注入代理对象
                    interceptor = new GlobalTransactionalInterceptor(failureHandlerHook);
                    ConfigurationFactory.getInstance().addConfigListener(ConfigurationKeys.DISABLE_GLOBAL_TRANSACTION, (ConfigurationChangeListener) interceptor);
                }
            }

            //判断当前bean是否已被aop代理过，比如说方法上加了@Transactional就会被spring代理
            //如果没有被代理，调用父类的模板方法进行代理，advisor通过被重写的
            //getAdvicesAndAdvisorsForBean返回上面的interceptor进行包装
            if (!AopUtils.isAopProxy(bean)) {
                bean = super.wrapIfNecessary(bean, beanName, cacheKey);
            } else {
                AdvisedSupport advised = SpringProxyUtils.getAdvisedSupport(bean);

                //把GlobalTransactionalInterceptor包装成advisor
                Advisor[] advisor = buildAdvisors(beanName, getAdvicesAndAdvisorsForBean(null, null, null));
                for (Advisor avr : advisor) {
                    advised.addAdvisor(0, avr);
                }
            }
            PROXYED_SET.add(beanName);
            return bean;
        }
    } catch (Exception exx) {
        throw new RuntimeException(exx);
    }
}

@Override
protected Object[] getAdvicesAndAdvisorsForBean(Class beanClass, String beanName,
  TargetSource customTargetSource) throws BeansException {

    //返回interceptor[]
    return new Object[]{interceptor};
}

@Override
    public void afterPropertiesSet() {
        if (disableGlobalTransaction) {
            if (LOGGER.isInfoEnabled()) {
                LOGGER.info("Global transaction is disabled.");
            }
            return;
        }
        //使用netty初始化seata client，建立到server端的连接
        initClient();
    }
```

[data:image/gif;base64,R0lGODlhAQABAPABAP///wAAACH5BAEKAAAALAAAAAABAAEAAAICRAEAOw==](data:image/gif;base64,R0lGODlhAQABAPABAP///wAAACH5BAEKAAAALAAAAAABAAEAAAICRAEAOw==)

这里可以看出来，只要我们在方法上加了@GlobalTranscational注解，对应的bean就会被seata进行代理，同时重写了afterPropertiesSet，在bean初始化完毕后会进行调用，这个client就是用来跟server端通信的，包括后面会说到的下游服务的事务提交与回滚都与这个有关

GlobalTransactionalInterceptor重写了MethodInterceptor的invoke()方法，在spring执行通知代理对象的通知方法时，最终会调用到这个invoke()

```
@Override
public Object invoke(final MethodInvocation methodInvocation) throws Throwable {
        Class<?> targetClass = methodInvocation.getThis() != null ?AopUtils.getTargetClass(methodInvocation.getThis()) : null;
        Method specificMethod = ClassUtils.getMostSpecificMethod(methodInvocation.getMethod(), targetClass);
        final Method method = BridgeMethodResolver.findBridgedMethod(specificMethod);

        final GlobalTransactional globalTransactionalAnnotation = getAnnotation(method, GlobalTransactional.class);
        final GlobalLock globalLockAnnotation = getAnnotation(method, GlobalLock.class);
        //如果全局事务可用并且方法上加了@GlobalTransactional注解
        if (!disable && globalTransactionalAnnotation != null) {
            //处理全局事务
            return handleGlobalTransaction(methodInvocation, globalTransactionalAnnotation);
        } else if (!disable && globalLockAnnotation != null) {
            return handleGlobalLock(methodInvocation);
        } else {
            return methodInvocation.proceed();
        }
    }
```

[data:image/gif;base64,R0lGODlhAQABAPABAP///wAAACH5BAEKAAAALAAAAAABAAEAAAICRAEAOw==](data:image/gif;base64,R0lGODlhAQABAPABAP///wAAACH5BAEKAAAALAAAAAABAAEAAAICRAEAOw==)

这里就会然后调用handleGlobalTransaction(methodInvocation, globalTransactionalAnnotation);

```
private Object handleGlobalTransaction(final MethodInvocation methodInvocation,
                                           final GlobalTransactional globalTrxAnno) throws Throwable {
        try {
            return transactionalTemplate.execute(new TransactionalExecutor() {
                @Override
                public Object execute() throws Throwable {
                    return methodInvocation.proceed();
                }

                public String name() {
                    String name = globalTrxAnno.name();
                    if (!StringUtils.isNullOrEmpty(name)) {
                        return name;
                    }
                    return formatMethod(methodInvocation.getMethod());
                }

                @Override
                public TransactionInfo getTransactionInfo() {
                    TransactionInfo transactionInfo = new TransactionInfo();
                    transactionInfo.setTimeOut(globalTrxAnno.timeoutMills());
                    transactionInfo.setName(name());
                    transactionInfo.setPropagation(globalTrxAnno.propagation());
                    Set<RollbackRule> rollbackRules = new LinkedHashSet<>();
                    for (Class<?> rbRule : globalTrxAnno.rollbackFor()) {
                        rollbackRules.add(new RollbackRule(rbRule));
                    }
                    for (String rbRule : globalTrxAnno.rollbackForClassName()) {
                        rollbackRules.add(new RollbackRule(rbRule));
                    }
                    for (Class<?> rbRule : globalTrxAnno.noRollbackFor()) {
                        rollbackRules.add(new NoRollbackRule(rbRule));
                    }
                    for (String rbRule : globalTrxAnno.noRollbackForClassName()) {
                        rollbackRules.add(new NoRollbackRule(rbRule));
                    }
                    transactionInfo.setRollbackRules(rollbackRules);
                    return transactionInfo;
                }
            });
        } catch (TransactionalExecutor.ExecutionException e) {
            TransactionalExecutor.Code code = e.getCode();
            switch (code) {
                case RollbackDone:
                    throw e.getOriginalException();
                case BeginFailure:
                    failureHandler.onBeginFailure(e.getTransaction(), e.getCause());
                    throw e.getCause();
                case CommitFailure:
                    failureHandler.onCommitFailure(e.getTransaction(), e.getCause());
                    throw e.getCause();
                case RollbackFailure:
                    failureHandler.onRollbackFailure(e.getTransaction(), e.getCause());
                    throw e.getCause();
                case RollbackRetrying:
                    failureHandler.onRollbackRetrying(e.getTransaction(), e.getCause());
                    throw e.getCause();
                default:
                    throw new ShouldNeverHappenException(String.format("Unknown TransactionalExecutor.Code: %s", code));

            }
        }
    }
```

[data:image/gif;base64,R0lGODlhAQABAPABAP///wAAACH5BAEKAAAALAAAAAABAAEAAAICRAEAOw==](data:image/gif;base64,R0lGODlhAQABAPABAP///wAAACH5BAEKAAAALAAAAAABAAEAAAICRAEAOw==)

这里transactionalTemplate.execute（）传入了一个匿名实现，其execute()就是放行让后续的通知方法继续执行，这个我们不关心，进入transactionalTemplate.execute（）

```
public Object execute(TransactionalExecutor business) throws Throwable {
        // 1 get transactionInfo
        TransactionInfo txInfo = business.getTransactionInfo();
        if (txInfo == null) {
            throw new ShouldNeverHappenException("transactionInfo does not exist");
        }
        // 1.1 get or create a transaction
        GlobalTransaction tx = GlobalTransactionContext.getCurrentOrCreate();

        // 1.2 Handle the Transaction propatation and the branchType
        Propagation propagation = txInfo.getPropagation();
        SuspendedResourcesHolder suspendedResourcesHolder = null;
        try {
            switch (propagation) {
                case NOT_SUPPORTED:
                    suspendedResourcesHolder = tx.suspend(true);
                    return business.execute();
                case REQUIRES_NEW:
                    suspendedResourcesHolder = tx.suspend(true);
                    break;
                case SUPPORTS:
                    if (!existingTransaction()) {
                        return business.execute();
                    }
                    break;
                case REQUIRED:
                    break;
                case NEVER:
                    if (existingTransaction()) {
                        throw new TransactionException(
                                String.format("Existing transaction found for transaction marked with propagation 'never',xid = %s"
                                        ,RootContext.getXID()));
                    } else {
                        return business.execute();
                    }
                case MANDATORY:
                    if (!existingTransaction()) {
                        throw new TransactionException("No existing transaction found for transaction marked with propagation 'mandatory'");
                    }
                    break;
                default:
                    throw new TransactionException("Not Supported Propagation:" + propagation);
            }

            try {

                // 2. begin transaction
                beginTransaction(txInfo, tx);

                Object rs = null;
                try {

                    // Do Your Business
                    rs = business.execute();

                } catch (Throwable ex) {

                    // 3.the needed business exception to rollback.
                    completeTransactionAfterThrowing(txInfo, tx, ex);
                    throw ex;
                }

                // 4. everything is fine, commit.
                commitTransaction(tx);

                return rs;
            } finally {
                //5. clear
                triggerAfterCompletion();
                cleanUp();
            }
        } finally {
            tx.resume(suspendedResourcesHolder);
        }

    }
```

[data:image/gif;base64,R0lGODlhAQABAPABAP///wAAACH5BAEKAAAALAAAAAABAAEAAAICRAEAOw==](data:image/gif;base64,R0lGODlhAQABAPABAP///wAAACH5BAEKAAAALAAAAAABAAEAAAICRAEAOw==)

这里首先初始化一个GlobalTransaction实例tx，用于保存后续生成的xid跟事务状态等一些属性。然后对事务的传播属性做了些校验。然后我们进入beginTransaction(txInfo, tx);顾名思义，这里快要到核心了

```
private void beginTransaction(TransactionInfo txInfo, GlobalTransaction tx) throws TransactionalExecutor.ExecutionException {
        try {
            //执行hook的begin()方法做一些额外处理
            triggerBeforeBegin();
            tx.begin(txInfo.getTimeOut(), txInfo.getName());
            triggerAfterBegin();
        } catch (TransactionException txe) {
            throw new TransactionalExecutor.ExecutionException(tx, txe,
                TransactionalExecutor.Code.BeginFailure);

        }
    }
```

[data:image/gif;base64,R0lGODlhAQABAPABAP///wAAACH5BAEKAAAALAAAAAABAAEAAAICRAEAOw==](data:image/gif;base64,R0lGODlhAQABAPABAP///wAAACH5BAEKAAAALAAAAAABAAEAAAICRAEAOw==)

这里的trigger方法执行我们通过TransactionHookManager.registerHook()注册的一些hook方法，如果我们要在事务开始前后做一些事情，就可以通过这种方式。

进入tx.begin()

```
    @Override
    public void begin(int timeout, String name) throws TransactionException {
        if (role != GlobalTransactionRole.Launcher) {
            assertXIDNotNull();
            if (LOGGER.isDebugEnabled()) {
                LOGGER.debug("Ignore Begin(): just involved in global transaction [{}]", xid);
            }
            return;
        }
        assertXIDNull();
        if (RootContext.getXID() != null) {
            throw new IllegalStateException();
        }

        //开启事务并拿到xid
        xid = transactionManager.begin(null, null, name, timeout);
        //设置事务状态
        status = GlobalStatus.Begin;
        //xid跟当前线程做全局绑定
        RootContext.bind(xid);
        if (LOGGER.isInfoEnabled()) {
            LOGGER.info("Begin new global transaction [{}]", xid);
        }

    }
```

[data:image/gif;base64,R0lGODlhAQABAPABAP///wAAACH5BAEKAAAALAAAAAABAAEAAAICRAEAOw==](data:image/gif;base64,R0lGODlhAQABAPABAP///wAAACH5BAEKAAAALAAAAAABAAEAAAICRAEAOw==)

继续到 transactionManager.begin

```
    @Override
    public String begin(String applicationId, String transactionServiceGroup, String name, int timeout)
        throws TransactionException {
        GlobalBeginRequest request = new GlobalBeginRequest();
        request.setTransactionName(name);
        request.setTimeout(timeout);

        //通知seata-server开启全局事务，并拿到全局事务id(xid)
        GlobalBeginResponse response = (GlobalBeginResponse)syncCall(request);
        if (response.getResultCode() == ResultCode.Failed) {
            throw new TmTransactionException(TransactionExceptionCode.BeginFailed, response.getMsg());
        }
        return response.getXid();
    }
```

[data:image/gif;base64,R0lGODlhAQABAPABAP///wAAACH5BAEKAAAALAAAAAABAAEAAAICRAEAOw==](data:image/gif;base64,R0lGODlhAQABAPABAP///wAAACH5BAEKAAAALAAAAAABAAEAAAICRAEAOw==)

最后我们就开启了一个全局事务，那么我们的xid是怎么向下游传递的呢，看看对feign的集成是怎么做的？SeataFeignClient.execute

```
    @Override
	public Response execute(Request request, Request.Options options) throws IOException {

        //设置xid
		Request modifiedRequest = getModifyRequest(request);
        //调用下游服务
		return this.delegate.execute(modifiedRequest, options);
	}

	private Request getModifyRequest(Request request) {

		String xid = RootContext.getXID();

		if (StringUtils.isEmpty(xid)) {
			return request;
		}

		Map<String, Collection<String>> headers = new HashMap<>(MAP_SIZE);
        //设置xid到消息头
		headers.putAll(request.headers());

		List<String> seataXid = new ArrayList<>();
		seataXid.add(xid);
		headers.put(RootContext.KEY_XID, seataXid);

		return Request.create(request.method(), request.url(), headers, request.body(),
				request.charset());
	}
```

[data:image/gif;base64,R0lGODlhAQABAPABAP///wAAACH5BAEKAAAALAAAAAABAAEAAAICRAEAOw==](data:image/gif;base64,R0lGODlhAQABAPABAP///wAAACH5BAEKAAAALAAAAAABAAEAAAICRAEAOw==)

这里用SeataFeignClient替换了默认的feignClient，把xid放到了requestHeader里。那么下游又是怎么拿的呢？SeataHandlerInterceptor.preHandle()

```
       @Override
	public boolean preHandle(HttpServletRequest request, HttpServletResponse response,
			Object handler) {

		String xid = RootContext.getXID();

                //从消息头中获取xid
		String rpcXid = request.getHeader(RootContext.KEY_XID);
		if (log.isDebugEnabled()) {
			log.debug("xid in RootContext {} xid in RpcContext {}", xid, rpcXid);
		}

		if (xid == null && rpcXid != null) {
			RootContext.bind(rpcXid);
			if (log.isDebugEnabled()) {
				log.debug("bind {} to RootContext", rpcXid);
			}
		}
		return true;
	}
```

[data:image/gif;base64,R0lGODlhAQABAPABAP///wAAACH5BAEKAAAALAAAAAABAAEAAAICRAEAOw==](data:image/gif;base64,R0lGODlhAQABAPABAP///wAAACH5BAEKAAAALAAAAAABAAEAAAICRAEAOw==)

这里SeataHandlerInterceptor实现了HandlerInterceptor，springMVC会在Controller方法调用之前拿到所有注册到容器中的拦截器链去执行其preHandle()方法，具体可参考DispatcherServlet.doDispatch()。

好了，到这里就大概把seata的全局事务的开启以及xid的传递捋了一遍，后面会聊聊seata跟hystrix做集成时常见的一些坑
