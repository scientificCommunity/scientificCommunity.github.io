---
title: Mysql之浅析AUTO_INCREMENT
date: 2022-02-09 17:25:09
tags:
  -  技术
  -  Mysql
categories: 技术
abbrlink: 34050
---
`AUTO_INCREMENT`用于为表中的列设置一个自增序列，在非集群模式下，用它来为主键列自动生成值是一件很方便的事。并且，Mysql提供了一系列的锁机制来保证它的性能跟可靠性，通过这些锁机制，我们可以让它变得很高效。

## 术语

先来了解后面将要用到的术语。

- Simple inserts
    
    能预先知道插入行数的语句。比如说单行插入（不包括[INSERT ... ON DUPLICATE KEY UPDATE](https://dev.mysql.com/doc/refman/8.0/en/insert-on-duplicate.html)），不带子句的多行插入（自增列不赋值或全赋值）。
    
- Bulk inserts
    
    不能能预先知道插入行数的语句。比如[INSERT ... SELECT](https://dev.mysql.com/doc/refman/8.0/en/insert-select.html), [REPLACE ... SELECT](https://dev.mysql.com/doc/refman/8.0/en/replace.html) 。这种模式下，`InnoDB` 会在处理时为每一行的自增列一次分配一个自增值
    
- Mixed-mode inserts
    
    ```sql
    INSERT INTO t1 (c1,c2) VALUES (1,'a'), (NULL,'b'), (5,'c'), (NULL,'d');
    ```
    
    [INSERT ... ON DUPLICATE KEY UPDATE](https://dev.mysql.com/doc/refman/8.0/en/insert-on-duplicate.html)
    
- Insert-like
    
    以上所有插入语句的统称
    

## 锁模式

锁模式在启动时通过`innodb_autoinc_lock_mode`这个变量来配置，它有3个值：`0, 1, 2`。分别对应`traditional`(传统)、`consecutive`(连续)、`interleaved`(交错)3种模式。

在`Mysql5.6~5.7`里，这个配置项的默认值是`1`，从`Mysql8`开始，它的默认值`2`。这个一方面是因为模式`2`的性能更好，另一方面是因为从`Mysql8`开始，默认的主从复制的方式由`statement-based` 改为了`row based`。`row based` 能保证`innodb_autoinc_lock_mode=2`时主从复制时的数据不会出现不一致的问题。好了，下面开始详细了解这三种锁模式吧！

- traditional
    
    在这种模式下，Mysql所有的`Insert-like`操作都会设置一个表级别的`AUTO-INC` 锁，这个锁会在单条语句执行完毕时释放。
    
    也就是说，如果有多个事务同时对同一张表执行`Insert-like` 操作，那么，即使它们没有操作同一条记录，也会串行执行。所以，它的性能相对另外两种模式来说会比较糟糕。
    
- consecutive
    
    在这种模式下，对于`Simple inserts`语句，`Mysql`会在语句执行的初始阶段将一条语句需要的所有自增值会一次性分配出来，并且通过设置一个互斥量来保证自增序列的一致性，一旦自增值生成完毕，这个互斥量会立即释放，不需要等到语句执行结束。
    
    所以，在`consecutive`模式，多事务并发执行`Simple inserts`这类语句时， 相对traditional模式，性能会有比较大的提升。
    
    由于一开始就为语句分配了所有需要的自增值，那么对于像`Mixed-mode inserts`这类语句，就有可能多分配了一些值给它，从而导致自增序列出现"**空隙**"。而`traditional`模式因为每一次只会为一条记录分配自增值，所有不会有这种问题。
    
    另外，对于`Bulk inserts`语句，依然会采取`AUTO-INC`锁。所以，如果有一条`Bulk inserts`语句正在执行的话，`Simple inserts`也必须等到该语句执行完毕才能继续执行。
    
- interleaved
    
    在这种模式下，对于所有的`Insert-like`语句，都不会存在表级别的`AUTO-INC`锁，意味着同一张表上的多个语句并发时阻塞会大幅减少。
    
    但是，这种模式必须运行在`row based`或者`mixed-format`(其实说白了也是row based，只不过mysql会根据自增模式为不安全的语句自动选择row based模式)复制模式下。因为`interleaved`这种模式下对于相同顺序的语句每次执行行都会产生不同的结果(谁竞争到**互斥量**，谁就能获得生成自增值的权利)，所以，如果复制模式是`statement-based`或者通过`binlog`进行数据恢复时(牵扯到binlog的语句重放)，可能会导致数据不一致。
    

## 注意点

- 自增值的生成后是不能回滚的，所以自增值生成后，事务回滚了，那么那些已经生成的自增值就丢失了，从而使自增列的数据出现空隙
- 正常情况下，自增列是不存在`0`这个值的。所以，如果插入语句中对自增列设置的值为`0`或者`null`，就会自动应用自增序列。
    
    那么，如果想在自增列中插入为0这个值，怎么办呢？可以通过将[SQL Mode](https://dev.mysql.com/doc/refman/8.0/en/sql-mode.html#sqlmode_no_auto_value_on_zero)设置为`NO_AUTO_VALUE_ON_ZERO`即可
    
- 在Mysql5.7以及更早之前，自增序列的计数器(`auto-increment counter`)是保存在内存中的。`auto-increment counter`在每次Mysql重新启动后通过类似下面的这种语句进行初始化：
    
    ```sql
    SELECT MAX(AUTO_INC_COLUMN) FROM table_name FOR UPDATE
    ```
    
    而从`Mysql8`开始，`auto-increment counter`被存储在了`redo log`中，并且每次变化都会刷新到`redo log`中。另外，我们可以通过[ALTER TABLE ... AUTO_INCREMENT = N](https://dev.mysql.com/doc/refman/8.0/en/alter-table.html) 来主动修改
    `auto-increment counter`。
    

## 总结

1. 单实例下，可以设置`innodb_autoinc_lock_mode=2`
2. 主从
    1. 复制模式为`statement-based`，设置`innodb_autoinc_lock_mode=1`
    2. 复制模式为`row based`或者`mixed-format`，设置`innodb_autoinc_lock_mode=2`
    

## 参考链接

- ****[15.6.1.6 AUTO_INCREMENT Handling in InnoDB](https://dev.mysql.com/doc/refman/8.0/en/innodb-auto-increment-handling.html#innodb-auto-increment-lock-mode-usage-implications)****
- **[15.18.2 InnoDB Recovery](https://dev.mysql.com/doc/refman/8.0/en/innodb-recovery.html)**
- ****[17.5.1.1 Replication and AUTO_INCREMENT](https://dev.mysql.com/doc/refman/8.0/en/replication-features-auto-increment.html)****
- **[3.6.9 Using AUTO_INCREMENT](https://dev.mysql.com/doc/refman/8.0/en/example-auto-increment.html)**
