export interface RequestWithHeaders {
  url: string
  requestHeaders: Record<string, string | string[]>
}

export function appendDesktopToken(
  details: RequestWithHeaders,
  applicationBaseUrl: string,
  token: string,
): Record<string, string | string[]> {
  if (!details.url.startsWith(`${applicationBaseUrl}/api/`) && details.url !== `${applicationBaseUrl}/api`) return details.requestHeaders
  return { ...details.requestHeaders, 'X-Desktop-Token': token }
}
