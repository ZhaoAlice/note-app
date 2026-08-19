type PromiseResolvers<T> = {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
}

type PromiseConstructorCompat = PromiseConstructor & {
  withResolvers?: <T>() => PromiseResolvers<T>
}

type UrlConstructorCompat = typeof URL & {
  parse?: (url: string, base?: string | URL) => URL | null
}

const PromiseCompat = Promise as PromiseConstructorCompat
if (!PromiseCompat.withResolvers) {
  PromiseCompat.withResolvers = function withResolvers<T>(): PromiseResolvers<T> {
    let resolve!: PromiseResolvers<T>['resolve']
    let reject!: PromiseResolvers<T>['reject']
    const promise = new Promise<T>((nextResolve, nextReject) => {
      resolve = nextResolve
      reject = nextReject
    })
    return { promise, resolve, reject }
  }
}

const UrlCompat = URL as UrlConstructorCompat
if (!UrlCompat.parse) {
  UrlCompat.parse = (url: string, base?: string | URL) => {
    try {
      return new URL(url, base)
    } catch {
      return null
    }
  }
}

export {}
