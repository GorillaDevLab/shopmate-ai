# Tencent Cloud Lighthouse Deployment Guide

本文件记录 ShopMate AI 在腾讯云轻量应用服务器（Lighthouse）上的 Demo 部署流程。

## 1. 部署架构

```text
Browser
  ↓ HTTP :80
Nginx
  ↓
Next.js Web :3000
  ↓ /api/* rewrite
NestJS API :3001
  ↓
PostgreSQL :5432
  ↓
DeepSeek API
```
