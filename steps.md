# steps.md — companion to AGENTS.md

A worked example of the plan that **Phase 1 (Gemini)** must produce from a lab PDF.
The exact structure below is the contract the parser (`src/parser.ts`) consumes:
`## Step <n>`, `**Environment:**`, `**Command:**` code fence, `**Expected:**`.

This is a deliverable of v1. It can double as a golden fixture for parser tests.

## Step 1
**Environment:** bash
**Command:**
```bash
echo "Hello, DBMS Lab"
```
**Expected:**
Prints `Hello, DBMS Lab` to the terminal.

## Step 2
**Environment:** bash
**Command:**
```bash
mysql --version
```
**Expected:**
Prints the installed MySQL/MariaDB client version, e.g. `mysql Ver 8.0.x for Linux`.

## Step 3
**Environment:** mysql
**Command:**
```sql
CREATE DATABASE lab1;
```
**Expected:**
Query OK, 1 row affected. No error about an existing database if run after Step 2 of a fresh session.

## Step 4
**Environment:** mysql
**Command:**
```sql
USE lab1;
```
**Expected:**
`Database changed`.

## Step 5
**Environment:** mysql
**Command:**
```sql
SHOW TABLES;
```
**Expected:**
`Empty set` (0.00 sec) — the new lab1 database has no tables yet.

## Step 6
**Environment:** python
**Command:**
```python
print(2 ** 10)
```
**Expected:**
The REPL prints `1024`.