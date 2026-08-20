import path from 'node:path'
import type { ForgeConfig } from '@electron-forge/shared-types'
import { MakerDeb } from '@electron-forge/maker-deb'
import { MakerDMG } from '@electron-forge/maker-dmg'
import { MakerRpm } from '@electron-forge/maker-rpm'
import { MakerSquirrel } from '@electron-forge/maker-squirrel'
import { MakerZIP } from '@electron-forge/maker-zip'

const resources = path.resolve(__dirname, 'resources')
const documentTypes = [
  { CFBundleTypeExtensions: ['epub'], CFBundleTypeName: 'EPUB Book', CFBundleTypeRole: 'Viewer', LSHandlerRank: 'Alternate' },
  { CFBundleTypeExtensions: ['pdf'], CFBundleTypeName: 'PDF Document', CFBundleTypeRole: 'Viewer', LSHandlerRank: 'Alternate' },
  { CFBundleTypeExtensions: ['txt'], CFBundleTypeName: 'Text Document', CFBundleTypeRole: 'Viewer', LSHandlerRank: 'Alternate' },
  { CFBundleTypeExtensions: ['md', 'markdown'], CFBundleTypeName: 'Markdown Document', CFBundleTypeRole: 'Viewer', LSHandlerRank: 'Alternate' },
]

const config: ForgeConfig = {
  packagerConfig: {
    name: 'Shijian',
    executableName: 'Shijian',
    appBundleId: 'com.zhaoalice.shijian',
    appCategoryType: 'public.app-category.productivity',
    asar: true,
    ignore: [/^\/resources(?:\/|$)/, /^\/out(?:\/|$)/, /^\/coverage(?:\/|$)/],
    extraResource: [
      path.join(resources, 'frontend'),
      path.join(resources, 'sidecar'),
      path.join(resources, 'ocr-models'),
    ],
    extendInfo: { CFBundleDisplayName: '拾笺', CFBundleDocumentTypes: documentTypes },
  },
  makers: [
    new MakerSquirrel({ name: 'Shijian', setupExe: 'ShijianSetup-x64.exe' }),
    new MakerZIP({}, ['darwin']),
    new MakerDMG({ name: 'Shijian' }),
    new MakerDeb({ options: { name: 'shijian', productName: '拾笺', categories: ['Office'], mimeType: ['application/epub+zip', 'application/pdf', 'text/plain', 'text/markdown'] } }),
    new MakerRpm({ options: { name: 'shijian', productName: '拾笺', categories: ['Office'], mimeType: ['application/epub+zip', 'application/pdf', 'text/plain', 'text/markdown'] } }),
  ],
}

export default config
