import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3
}

export class Logger {
  private static instance: Logger;
  private logFile: fs.WriteStream | null = null;
  private logLevel: LogLevel = LogLevel.INFO;
  private isDevelopment: boolean = process.env.NODE_ENV === 'development';
  private isDebugMode: boolean = process.env.FREERIDER_DEBUG === '1';

  private constructor() {
    this.initializeLogFile();
    this.logLevel = this.isDebugMode ? LogLevel.DEBUG : LogLevel.INFO;
  }

  static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }

  private initializeLogFile(): void {
    try {
      const logDir = path.join(app.getPath('userData'), 'logs');
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }

      const logFileName = `freerider-${new Date().toISOString().split('T')[0]}.log`;
      const logPath = path.join(logDir, logFileName);

      this.logFile = fs.createWriteStream(logPath, { flags: 'a' });
    } catch (error) {
      console.error('Failed to initialize log file:', error);
    }
  }

  private formatMessage(level: string, context: string, message: string): string {
    const timestamp = new Date().toISOString();
    return `[${timestamp}] [${level}] [${context}] ${message}`;
  }

  private writeToFile(message: string): void {
    if (this.logFile && this.logFile.writable) {
      this.logFile.write(message + '\n');
    }
  }

  private shouldLog(level: LogLevel): boolean {
    return level >= this.logLevel;
  }

  debug(context: string, message: string, data?: any): void {
    if (!this.shouldLog(LogLevel.DEBUG)) return;

    const formatted = this.formatMessage('DEBUG', context, message);
    if (this.isDebugMode || this.isDevelopment) {
      console.log(formatted, data || '');
    }
    this.writeToFile(formatted + (data ? ` ${JSON.stringify(data)}` : ''));
  }

  info(context: string, message: string, data?: any): void {
    if (!this.shouldLog(LogLevel.INFO)) return;

    const formatted = this.formatMessage('INFO', context, message);
    console.log(formatted, data || '');
    this.writeToFile(formatted + (data ? ` ${JSON.stringify(data)}` : ''));
  }

  warn(context: string, message: string, data?: any): void {
    if (!this.shouldLog(LogLevel.WARN)) return;

    const formatted = this.formatMessage('WARN', context, message);
    console.warn(formatted, data || '');
    this.writeToFile(formatted + (data ? ` ${JSON.stringify(data)}` : ''));
  }

  error(context: string, message: string, error?: Error | any): void {
    if (!this.shouldLog(LogLevel.ERROR)) return;

    const formatted = this.formatMessage('ERROR', context, message);
    console.error(formatted, error || '');

    const errorData = error instanceof Error
      ? { message: error.message, stack: error.stack }
      : error;

    this.writeToFile(formatted + (errorData ? ` ${JSON.stringify(errorData)}` : ''));
  }

  setLogLevel(level: LogLevel): void {
    this.logLevel = level;
  }

  close(): void {
    if (this.logFile) {
      this.logFile.end();
      this.logFile = null;
    }
  }
}

export const logger = Logger.getInstance();
