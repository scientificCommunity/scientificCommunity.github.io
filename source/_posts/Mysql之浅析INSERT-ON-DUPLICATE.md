---
title: Mysql之浅析INSERT ON DUPLICATE
tags: 技术, Mysql
categories: 技术
abbrlink: 34049
date: 2022-01-04 14:00:00
---

# 前言
如果不特别指出，默认mysql版本为8.0
# 简介
往数据库中插入记录时，如果发生唯一索引值冲突，insert on duplicate允许进行进一步的crud操作。伪代码如下：
```
insert record
IF exist duplicate record THEN
  do something on duplicated rows
ELSE 
  do nothing
END IF
```
# 具体用法
先初始化将要用到的表跟数据
```sql
create table t1
(
    id bigint primary key auto_increment,
    a  integer unique,
    b  integer default 999
);
INSERT INTO test_insert_on_dup_update(id, a)
VALUES (1, 1);
INSERT INTO test_insert_on_dup_update(id, a)
VALUES (5, 5);
INSERT INTO test_insert_on_dup_update(id, a)
VALUES (10, 10);
```
## 1. 单个唯一索引插入冲突
通过如下sql进行数据插入
```
insert into t1(a,b) values(1,199) on duplicate update b = 1;
```
因为表中已经存在**a=1**的记录，这个时候会触发on duplicate后面的update操作，将a=1的记录的b从999修改为1.

**在这种情况下，上面的sql等价于**
```sql
update b=1 where a = 1;
```
## 1.2 多个唯一索引插入冲突
如果插入的记录与a跟b上的索引值都发生了冲突，且发生冲突的记录有多条会怎么样呢？
```sql
insert into t1(id, a) values(1,5) 
  on duplicate update b = 1;
```
因为a=1跟b=5都存在，这个时候**有两行记录与即将插入的记录有冲突**。按照[前面](#简介)介绍的规则来看，貌似**id=1**跟**a=5**这两条记录的`b`都会被更新成1。但事实是只有一条有冲突的记录会应用`on duplicate`后面的子句。而这条被命中记录就是**在所有满足条件的记录中**，其**id值**在**聚集索引叶节点的链表中最靠前的那条记录**。在本例中也就是id=1的那条记录。该sql的实际效果等价于
```sql
update t1 set b=1 where id=1 or a=5 limit 1;
```
所以，当发生这种情况时，我们很难去预料语句的行为。**应当尽量避免这种情况**。

## 1.3 子句获取插入列即将插入的值
### 在8.0.19之前
```sql
insert into t1(id, a) values(1,5) 
  on duplicate update b = values(a);
```
等价于
```sql
insert into t1(id, a) values(1,5) 
  on duplicate update b = 5;
```
`values(a)`获取的是原本准备插入的`a=5`这个值.

要注意的是：**这种写法将在8.0.20版本被废弃，对应的功能在未来会被移除。**
### 在8.0.19之后
```sql
insert into t1(id, a) values(1,5) as new
  on duplicate update b = new.a;
```
这里为新插入的记录设置了一个别名`new`，通过这个别名可以获取到准备插入的数据。另外，还可以基于这个别名更进一步的为里面的每个列设置别名
```sql
insert into t1(id, a) values(1,5) as new(x,y)
  on duplicate update b = x;
```
## 1.4 根据查询结果进行插入

```sql
insert into t1(id, a) select x,y from t2
  on duplicate update b = x
```
像这类语句，由于插入的顺序依赖于select的结果集里行的顺序，而mysql不能保证这个select的结果集在主从上的顺序是完全一致的，这就会导致基于statement的主从复制会出现数据不一致的问题。而基于行的复制模式不存在这个问题。所以，如果存在这类子句中带`select`的sql，注意将复制模式设置为`row-based`或者`mixed`


# 跟锁相关的部分
根据不同的隔离级别，有如下特征：

1.  `repeatable read`

    -   普通唯一索引（非主键）发生唯一key冲突，这种情况会锁住该索引以及聚集索引。
    -   主键值发生冲突。则会为发生冲突的主键值设置**行锁**。

2.  `READ COMMITTED`：会为冲突的索引值设置行锁
