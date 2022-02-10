---
title: 踩坑日记之Springfox+Kotlin lateinit引发NullPointException
tags: 技术
categories: 技术
description: 在定义完接口后发现Springfox初始化swagger时报了空指针，导致swagger api doc无法加载
abbrlink: 4a9faf5f
date: 2021-09-03 13:24:47
---
# 相关技术栈

`Kotlin1.5`  `Springboot2.5` `Springfox3.0`

# 起因

最近对接支付宝的电脑网站支付，需要定义一个支持表单Post提交的接口来接收支付宝的回调。在定义完接口后发现`Springfox`初始化`swagger`时报了空指针，导致`swagger api doc`无法加载

# 分析

## 1. 报错位置

`springfox.documentation.service.RequestParameter#equals`

`springfox.documentation.schema.Example#equals`

## 2. 接口定义

首先，来看看出问题的接口定义

```kotlin
@ApiOperation("xxx")
@ApiResponse(
    code = 0,
    message = "ok",
)
@PostMapping(
    "/api",
    consumes = [MediaType.APPLICATION_FORM_URLENCODED_VALUE]
)
fun api(dto:Dto) {
		//do something
}
```

Dto定义

```kotlin
@ApiModel
class Dto {
	@ApiModelProperty
	lateinit var field: String
}
```

## 3. Kotlin编译成Java

看起来似乎没啥毛病，很nice。为什么会报空指针呢？首先我们来看下Dto编译成Java代码是什么样子

```kotlin
public final class Dto {
   @ApiModelProperty
   public String field;

   @NotNull
   public final String getField() {
      String var1 = this.field;
      if (var1 != null) {
         return var1;
      } else {
         Intrinsics.throwUninitializedPropertyAccessException("field");
         throw null;
      }
   }

   public final void setField(@NotNull String var1) {
      Intrinsics.checkNotNullParameter(var1, var1);
      this.field = var1;
   }
}
```

可以发现，field访问修饰符是public。事实上这个public就是罪魁祸首

## 4. springfox源码分析

我们先来看一下springfox处理接口参数的一个大致过程

1. 判断接口参数前是否加了`@RequestBody`等参数，如果没加则进入第二步
2. 将Dto里的所有public属性跟public get方法包装成`RequestParameter`
3. 将所有的`RequestParameter` 添加到`HashSet`

### 1. 判断是否加了`@RequestBody`等参数

先看看第一步相关的源码

```kotlin
package springfox.documentation.spring.web.readers.operation;

public class OperationParameterReader implements OperationBuilderPlugin {

	private List<Compatibility<springfox.documentation.service.Parameter, RequestParameter>>
	  readParameters(OperationContext context) {
	    List<ResolvedMethodParameter> methodParameters = context.getParameters();
	    List<Compatibility<springfox.documentation.service.Parameter, RequestParameter>> parameters = new ArrayList<>();

	    int index = 0;
		//1. 遍历方法所有参数
	    for (ResolvedMethodParameter methodParameter : methodParameters) {
			//2. 判断是否需要扩展。
	        if (shouldExpand(methodParameter, alternate)) {
	          parameters.addAll(
	              expander.expand(
	                  new ExpansionContext("", alternate, context)));
	        } else {
	          //...
	        }
	    }
	    return parameters.stream()
	        .filter(hiddenParameter().negate())
	        .collect(toList());
	  }

	private boolean shouldExpand(final ResolvedMethodParameter parameter, ResolvedType resolvedParamType) {
	    return !parameter.hasParameterAnnotation(RequestBody.class)
	        && !parameter.hasParameterAnnotation(RequestPart.class)
	        && !parameter.hasParameterAnnotation(RequestParam.class)
	        && !parameter.hasParameterAnnotation(PathVariable.class)
	        && !builtInScalarType(resolvedParamType.getErasedType()).isPresent()
	        && !enumTypeDeterminer.isEnum(resolvedParamType.getErasedType())
	        && !isContainerType(resolvedParamType)
	        && !isMapType(resolvedParamType);
	  }
 }
```

这里可以看到shouldExpand会判断我们的参数是否被@RequestBody这类注解标注，而我们定义的接口是一个接收form表单的post接口，其前面的注解应该是`@ModelAttribute`（不加也可以）。所以这里就会进到`expander.expand`这里会将类拆解开来，对每个字段逐一解析。 然后进入到如下代码：

```kotlin
public class ModelAttributeParameterExpander {
		public List<Compatibility<springfox.documentation.service.Parameter, RequestParameter>> expand(
		      ExpansionContext context) {
			//...

			//将model里所有的getter方法跟public修饰的字段包装成ModelAttributeField
		    List<ModelAttributeField> attributes =
		        allModelAttributes(
		            propertyLookupByGetter,
		            getters,
		            fieldsByName,
		            alternateTypeProvider,
		            context.ignorableTypes());
				//处理getter方法跟public字段，将其包装为对应的RequestParamter
				simpleFields.forEach(each -> parameters.add(simpleFields(context.getParentName(), context, each)));
				    return parameters.stream()
				        .filter(hiddenParameter().negate())
				        .filter(voidParameters().negate())
				        .collect(toList());
		}

	private List<ModelAttributeField> allModelAttributes(
	      Map<Method, PropertyDescriptor> propertyLookupByGetter,
	      Iterable<ResolvedMethod> getters,
	      Map<String, ResolvedField> fieldsByName,
	      AlternateTypeProvider alternateTypeProvider,
	      Collection<Class> ignorables) {
	
		//所有getter方法
	    Stream<ModelAttributeField> modelAttributesFromGetters =
	        StreamSupport.stream(getters.spliterator(), false)
	            .filter(method -> !ignored(alternateTypeProvider, method, ignorables))
	            .map(toModelAttributeField(fieldsByName, propertyLookupByGetter, alternateTypeProvider));
	
		//所有public修饰的字段
	    Stream<ModelAttributeField> modelAttributesFromFields =
	        fieldsByName.values().stream()
	            .filter(ResolvedMember::isPublic)
	            .filter(ResolvedMember::isPublic)
	            .map(toModelAttributeField(alternateTypeProvider));
	
	    return Stream.concat(
	        modelAttributesFromFields,
	        modelAttributesFromGetters)
	        .collect(toList());
	  }
 }
```

接下来通过`ModelAttributeParameterExpander.simpleFields`进入如下代码

```kotlin
package springfox.documentation.swagger.readers.parameter;

public class SwaggerExpandedParameterBuilder implements ExpandedParameterBuilderPlugin {
	@Override
  public void apply(ParameterExpansionContext context) {
  
	//1. 查找字段上的ApiModelProperty注解，context则为单个字段或者getter方法的信息集合
	//如果字段上存在ApiModelProperty注解，则返回的Optional存在相关注解包装对象
	//如果是getter方法，在context的metadataAccessor中会保留一份getter对应的字段的信息
	//所以这里字段跟getter的处理方式相同
    Optional<ApiModelProperty> apiModelPropertyOptional = context.findAnnotation(ApiModelProperty.class);
    
	//2. 如果字段上存在ApiModelProperty注解，则执行fromApiModelProperty
    apiModelPropertyOptional.ifPresent(apiModelProperty -> fromApiModelProperty(context, apiModelProperty));
  }
}
```

显然，我们的`Dto`的`field`字段上是有`ApiModelProperty`注解的。所以接下来进入`fromApiModelProperty`

### 2. 包装`RequestParameter`

```kotlin
package springfox.documentation.swagger.readers.parameter;

public class SwaggerExpandedParameterBuilder implements ExpandedParameterBuilderPlugin {
		private void fromApiModelProperty(
	      ParameterExpansionContext context,
	      ApiModelProperty apiModelProperty) {
		//...

		//1. 生成RequestParameterBuilder
	    context.getRequestParameterBuilder()
	           .description(descriptions.resolve(apiModelProperty.value()))
	           .required(apiModelProperty.required())
	           .hidden(apiModelProperty.hidden())
				//2. apiModelProperty.example()默认返回空字符串。
				//所以这里会生成一个除了value其他字段都为空的Example实例
	           .example(new ExampleBuilder().value(apiModelProperty.example()).build())
	           .precedence(SWAGGER_PLUGIN_ORDER)
	           .query(q -> q.enumerationFacet(e -> e.allowedValues(allowable)));
	  }
}
```

所以这里就会生成一个跟我们字段或者getter对应的`RequestParameterBuilder`，且其字段`scalarExample`除了`value`以外其他字段都为`null`。同时可以看出来，字段跟与字段对应的`getter`生成的`RequestParameterBuilder`应该是**一模一样的，因为取的都是字段注解上的信息.**

所以，其`build()`出来的`RequestParameter`的字段值也是一模一样的。因为是`RequestParameter#equals`报错，我们先来看看其equals方法

```kotlin
public boolean equals(Object o) {
    if (this == o) {
      return true;
    }
    if (o == null || getClass() != o.getClass()) {
      return false;
    }
    RequestParameter that = (RequestParameter) o;
    return parameterIndex == that.parameterIndex &&
        Objects.equals(scalarExample, that.scalarExample);
  }
```

可以看到最终会对`RequestParameter`里的`scalarExample`进行equals比较。所以如果`scalarExample`不为空则必然进入进入`Example#equals`

```kotlin
  @Override
  public boolean equals(Object o) {
    if (this == o) {
      return true;
    }
    if (o == null || getClass() != o.getClass()) {
      return false;
    }
    Example example = (Example) o;
    return id.equals(example.id) &&
        Objects.equals(summary, example.summary) &&
        Objects.equals(description, example.description) &&
        value.equals(example.value) &&
        externalValue.equals(example.externalValue) &&
        mediaType.equals(example.mediaType) &&
        extensions.equals(example.extensions);
  }
```

还记得前面提到的`RequestParameterBuilder`只为Example的value字段赋了值吗？所以，只要触发`Example#equals` ，则必然会报出`NullPointException`

所以接下来这个RequestParameterBuilder在哪完成build()其实已经不需要关心了，我们只需要找到是哪里触发了这个equals即可。

### 3. 将`RequestParameter` 添加到`HashSet`

我们进入第一步所展示的代码的调用方，代码片段如下：

```kotlin
package springfox.documentation.spring.web.readers.operation;

public class OperationParameterReader implements OperationBuilderPlugin {
	@Override
  public void apply(OperationContext context) {

	//触发第一步
    List<Compatibility<springfox.documentation.service.Parameter, RequestParameter>> compatibilities
        = readParameters(context);

	//拿出compatibilities#getModern返回的数据组成一个HashSet
    Collection<RequestParameter> requestParameters = compatibilities.stream()
        .map(Compatibility::getModern)
        .filter(Optional::isPresent)
        .map(Optional::get)
        .collect(toSet());
    context.operationBuilder()
        .requestParameters(aggregator.aggregate(requestParameters));
  }
}
```

看到HashSet是不是突然想到了什么？没错，HashCode相同导致Hash碰撞进而触发equals。所以我们先来看看`compatibilities#getModern`究竟返回了什么。

```kotlin
package springfox.documentation.spring.web.plugins;

//OperationParameterReader.readParameters
//	-> ModelAttributeParameterExpander.expand
//    -> ModelAttributeParameterExpander.simpleFields
//      -> DocumentationPluginsManager.expandParameter
public class DocumentationPluginsManager {
		public Compatibility<springfox.documentation.service.Parameter, RequestParameter> expandParameter(
		    ParameterExpansionContext context) {
		  for (ExpandedParameterBuilderPlugin each : parameterExpanderPlugins.getPluginsFor(context.getDocumentationType())) {
		    each.apply(context);
		  }
		  return new Compatibility<>(
		      context.getParameterBuilder().build(),
		      context.getRequestParameterBuilder().build());
		}
}
```

我在上面列出了调用链，可以看到，`compatibilities#getModern`返回的就是我们之前说的`RequestParameter`。好家伙，赶紧去看`RequestParameter#hashCode`

```kotlin
  @Override
  public int hashCode() {
    return Objects.hash(name,
        parameterIndex,
        in,
        description,
        required,
        deprecated,
        hidden,
        parameterSpecification,
        precedence,
        scalarExample,
        examples,
        extensions);
  }
```

这里可以看出，如果存在两个字段值相同的`RequestParameter`，则势必会在因为hash碰撞而触发equals，从而最终导致`NullPointException`。

## 关于hash碰撞的代码片段

```kotlin
package java.util;

public class HashMap<K,V> extends AbstractMap<K,V>
    implements Map<K,V>, Cloneable, Serializable {

	final V putVal(int hash, K key, V value, boolean onlyIfAbsent,
	                   boolean evict) {
	        Node<K,V>[] tab; Node<K,V> p; int n, i;
			//为空则初始化
	        if ((tab = table) == null || (n = tab.length) == 0)
	            n = (tab = resize()).length;
			//hash值与长度-1按位与。
			//hash值相同的key必然会落到数组中同一个位置从而后来的元素会进入else
	        if ((p = tab[i = (n - 1) & hash]) == null)
	            tab[i] = newNode(hash, key, value, null);
	        else {
	            Node<K,V> e; K k;
	            if (p.hash == hash &&
	                ((k = p.key) == key || (key != null && key.equals(k))))
				//......
		}
}
```

# 总结

这次问题很奇葩，一方面是我对`Kotlin`还是不够熟，对`lateinit`的了解仅仅停留在很浅的层次。事实上我觉得这应该是`Kotlin`的编译不合理之处。因为正常的像`var`定义的属性，默认编译成java代码后，会生成一个私有的字段跟对应的`getter&setter`方法。同时，对于`lateinit`想要实现的功能（如果尝试访问没赋值的属性，会抛出异常），我觉得完全没必要把字段用`public`来修饰。

另一方面，我觉得`springfox`的设计也有不合理之处，既然有`RequestParameter#equals`的存在，为什么要允许前面这种默认只赋值一个`Example#value`的代码存在呢？且从表现上来看，一个public修饰的字段跟一个对应的getter方法，如果字段上不加@ApiModelProperty，则表现正常，加了，则直接导致NullpointException。这不合理，且容易令人困惑。

# github

[https://github.com/scientificCommunity/blog-sample/blob/main/src/main/kotlin/org/baichuan/example/spring/springfox/Application.kt](https://github.com/scientificCommunity/blog-sample/blob/main/src/main/kotlin/org/baichuan/example/spring/springfox/Application.kt)
