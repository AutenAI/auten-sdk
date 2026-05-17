export class AutenError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "AutenError";
  }
}

export class AuthError extends AutenError {
  constructor(message = "unauthorized") {
    super(message);
    this.name = "AuthError";
  }
}

export class ApiError extends AutenError {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

export class DeviceOfflineError extends AutenError {
  constructor(public readonly serial: string) {
    super(`device ${serial} is not connected`);
    this.name = "DeviceOfflineError";
  }
}
