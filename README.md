# 人机实验阅片工作台

一个面向 CT / MRI 人机实验场景的 Windows 本地阅片桌面应用。

项目当前主要用于离线科研流程：

- 加载本地 DICOM 病例
- 单窗或多分屏阅片
- 填写结构化报告
- 展示 AI 参考内容与推理
- 记录计时、问卷与提交结果
- 导出实验数据

本项目用于科研实验，不作为临床正式诊断系统使用。

## 技术栈

- Electron
- React
- TypeScript
- Vite
- `sql.js` 本地存储提交结果

## 当前功能

- 本地病例扫描与导入
- DICOM 切片浏览
- 分屏拖拽插入与替换
- 窗宽窗位、平移、旋转、翻转、测量
- 报告填写与实验流程控制
- 推理查看问卷与提交问卷
- CSV / JSON / DOCX / PDF 导出

## 项目结构

```text
dicom-reading-workbench/
├─ data/                 运行数据目录
│  └─ raw/               病例原始数据与配套 JSON
├─ electron/             Electron 主进程与预加载脚本
├─ scripts/              辅助脚本
├─ source-assets/        需求文档与参考素材
├─ src/                  React 前端源码
├─ tools/                本地便携工具（当前为 Node.js）
├─ index.html            Vite 入口页面
├─ package.json          依赖与脚本配置
├─ README.md             项目说明
├─ run.bat               Windows 启动脚本
├─ tsconfig.json         TypeScript 配置
└─ vite.config.ts        Vite 配置
```

## 关键文件

- `src/App.tsx`：主流程、报告区、问卷、计时、提交逻辑
- `src/components/DicomViewer.tsx`：阅片器、分屏布局、工具栏、拖拽替换
- `src/dicom.ts`：DICOM 解析与像素读取
- `src/types.ts`：共享类型定义
- `electron/main.cjs`：桌面壳、菜单、导入导出、数据库保存、IPC
- `electron/preload.cjs`：向前端暴露 `window.workbench` API

## 数据目录约定

程序从 `data/raw/` 扫描病例。

推荐结构：

```text
data/
  raw/
    001_CT/
      image001.dcm
      image002.dcm
    001_CT.json
```

支持的 DICOM 文件类型：

- `.dcm`
- `.dicom`
- `.ima`
- 无扩展名但文件头包含 `DICM` 的文件

病例对应 JSON 可包含：

```json
{
  "patientId": "20240506002311",
  "description": "AI 参考描述",
  "diagnosis": "AI 参考诊断",
  "reasoning": "AI 推理内容"
}
```

## 开发启动

已安装全局 Node.js 时：

```bash
npm install
npm run dev
```

在 Windows 下使用项目自带 Node.js 时：

```bat
set PATH=%CD%\tools\node-v22.22.3-win-x64;%PATH%
npm install
npm run dev
```

常用命令：

```bash
npm run dev
npm run build
npm run verify:data
```

## 说明

- 运行数据库默认保存在 `data/` 下
- 大体积数据、导出结果、构建产物默认不纳入 Git
- 原始需求文档保存在 `source-assets/` 下
