import type { reviewerApi } from './index'

declare global {
  interface Window {
    reviewer: typeof reviewerApi
  }
}
