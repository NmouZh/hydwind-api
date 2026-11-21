/**
 * 启动器上游错误的统一类型。
 *
 * 路由层只区分三件事：上游暂时不可用（502）、上游超时（504）和请求本身
 * 不合法（400 / 404）。把状态码放在错误对象上，避免每个服务函数各自
 * 拼 Response。
 */
export class UpstreamError extends Error {
  readonly status: 502 | 504;

  constructor(message: string, status: 502 | 504 = 502) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
  }
}

/** 上游明确返回 404：对调用方来说资源不存在，不是网关故障。 */
export class NotFoundError extends Error {
  constructor(message = 'not_found') {
    super(message);
    this.name = 'NotFoundError';
  }
}

/** 版本 JSON 自身不合法（非法 id、路径穿越、循环继承等）。 */
export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManifestError';
  }
}

/** 请求参数不合法（400），与上游故障区分开。 */
export class BadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadRequestError';
  }
}
