/**
 * 统一的日志工具
 * 用于在终端输出详细的调试信息
 */

export class Logger {
  private static getTimestamp(): string {
    const now = new Date();
    return now.toISOString();
  }

  private static formatObject(obj: any, indent: number = 2): string {
    try {
      return JSON.stringify(obj, null, indent);
    } catch (error) {
      return String(obj);
    }
  }

  /**
   * 记录 API 请求
   */
  static logRequest(service: string, method: string, url: string, payload: any) {
    console.log('\n' + '='.repeat(80));
    console.log(`[${this.getTimestamp()}] API 请求`);
    console.log('='.repeat(80));
    console.log(`服务: ${service}`);
    console.log(`方法: ${method}`);
    console.log(`URL: ${url}`);
    console.log('\n请求体:');
    console.log(this.formatObject(payload));
    console.log('='.repeat(80) + '\n');
  }

  /**
   * 记录 API 响应
   */
  static logResponse(service: string, status: number, data: any, duration?: number) {
    console.log('\n' + '='.repeat(80));
    console.log(`[${this.getTimestamp()}] API 响应`);
    console.log('='.repeat(80));
    console.log(`服务: ${service}`);
    console.log(`状态码: ${status}`);
    if (duration !== undefined) {
      console.log(`耗时: ${duration}ms`);
    }
    console.log('\n响应体:');
    console.log(this.formatObject(data));
    console.log('='.repeat(80) + '\n');
  }

  /**
   * 记录错误
   */
  static logError(service: string, operation: string, error: any) {
    console.log('\n' + '!'.repeat(80));
    console.log(`[${this.getTimestamp()}] 错误`);
    console.log('!'.repeat(80));
    console.log(`服务: ${service}`);
    console.log(`操作: ${operation}`);
    console.log(`错误类型: ${error?.name || 'Unknown'}`);
    console.log(`错误信息: ${error?.message || String(error)}`);
    if (error?.stack) {
      console.log('\n错误堆栈:');
      console.log(error.stack);
    }
    if (error?.response) {
      console.log('\n错误响应:');
      console.log(this.formatObject(error.response));
    }
    console.log('!'.repeat(80) + '\n');
  }

  /**
   * 记录操作开始
   */
  static logOperationStart(operation: string, params?: any) {
    console.log('\n' + '-'.repeat(80));
    console.log(`[${this.getTimestamp()}] 操作开始: ${operation}`);
    console.log('-'.repeat(80));
    if (params) {
      console.log('参数:');
      console.log(this.formatObject(params));
    }
    console.log('-'.repeat(80) + '\n');
  }

  /**
   * 记录操作完成
   */
  static logOperationEnd(operation: string, result?: any, duration?: number) {
    console.log('\n' + '-'.repeat(80));
    console.log(`[${this.getTimestamp()}] 操作完成: ${operation}`);
    console.log('-'.repeat(80));
    if (duration !== undefined) {
      console.log(`耗时: ${duration}ms`);
    }
    if (result) {
      console.log('结果:');
      console.log(this.formatObject(result));
    }
    console.log('-'.repeat(80) + '\n');
  }

  /**
   * 记录一般信息
   */
  static logInfo(message: string, data?: any) {
    console.log('\n' + '-'.repeat(80));
    console.log(`[${this.getTimestamp()}] 信息: ${message}`);
    if (data) {
      console.log(this.formatObject(data));
    }
    console.log('-'.repeat(80) + '\n');
  }

  /**
   * 记录数据处理
   */
  static logDataProcessing(step: string, input?: any, output?: any) {
    console.log('\n' + '-'.repeat(80));
    console.log(`[${this.getTimestamp()}] 数据处理: ${step}`);
    console.log('-'.repeat(80));
    if (input) {
      console.log('输入数据:');
      console.log(this.formatObject(input));
    }
    if (output) {
      console.log('\n输出数据:');
      console.log(this.formatObject(output));
    }
    console.log('-'.repeat(80) + '\n');
  }
}
