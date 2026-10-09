export class OfflineStartupError extends Error {
  constructor(options?: ErrorOptions) {
    super('The app started offline without a saved session', options);
    this.name = 'OfflineStartupError';
  }
}
