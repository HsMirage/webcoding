<desc_env>
# 当前系统与开发环境配置

1. **操作系统**：Windows 10 IoT Enterprise LTSC 2021 (Build 19044)
2. **终端约束**：提供的所有命令行指令必须完全兼容 Windows PowerShell。禁止提供仅适用于 Linux/macOS 的 Bash 特有命令（如 `ls -la`、`rm -rf` 等，请转换为对应的 PowerShell 命令）。
3. **核心环境版本**：
   - PowerShell：`5.1.19041`
   - Git：`2.52.0`
   - Python：`3.14.0`（pip `25.2`）
   - Node.js：`v24.12.0`（npm `11.7.0`，yarn `1.22.22`）
4. **环境隔离**：在提供 Python 或 Node.js 的安装指令时，默认考虑虚拟环境（如 `venv`）或本地项目安装，除非我明确要求全局安装。
</desc_env>