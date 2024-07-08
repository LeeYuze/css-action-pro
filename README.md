# Css Variables Code Action Prp

vscode 插件，自动遍历指定目录下的[css,less,scss]结尾的文件，遍历该文件的“颜色变量”,自动错误提醒和自动替换

```json
  "cssActionPro.autoReplace": false, //是否save后自动替换变量名称
  // "cssActionPro.variablesFiles": ["./src/styles/common.less"], // 指定指定文件
  "cssActionPro.variablesDirectory": "./src/styles/", // 指定遍历目录文件
  "cssActionPro.colorReplaceOptions": ["<%= _VAR_NAME_ %>"] //替换的格式
```
