// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import fs from 'node:fs/promises'
import path from 'node:path'

// Metal shaders are data, not Mach-O executables. Seal their bytes as a bundle
// resource; detached code signatures in xattrs do not survive updater archives.
// MLX's existing colocated lookup follows a relative link made BEFORE signing.
export async function stageMlxBundleResources(directory, source) {
  const resources = path.join(directory, 'Resources')
  const binaries = path.join(directory, 'MacOS')
  await fs.mkdir(resources, { recursive: true })
  await fs.mkdir(binaries, { recursive: true })
  const resource = path.join(resources, 'mlx.metallib')
  const link = path.join(binaries, 'mlx.metallib')
  await fs.rm(link, { force: true })
  await fs.rm(resource, { force: true })
  if (!source) return
  await fs.copyFile(source, resource)
  await fs.chmod(resource, 0o644)
  await fs.symlink('../Resources/mlx.metallib', link)
}

export function configureMacosSidecars(config, target) {
  if (!['aarch64-apple-darwin', 'x86_64-apple-darwin'].includes(target)) {
    throw new Error(`unknown macOS release target: ${target}`)
  }
  config.bundle ??= {}
  config.bundle.macOS ??= {}
  config.bundle.externalBin = [...new Set(config.bundle.externalBin ?? [])]
    .filter((entry) => entry !== 'mlx.metallib')
  const files = config.bundle.macOS.files ??= {}
  delete files['MacOS/mlx.metallib']
  delete files['MacOS/libonnxruntime.dylib']
  // Copy the directory, rather than a file, so Tauri preserves the symlink.
  files['.'] = '../.macos-sidecars'
  if (target === 'x86_64-apple-darwin') {
    files['MacOS/libonnxruntime.dylib'] = 'libonnxruntime.dylib'
  }
  return config
}

if (import.meta.main) {
  // Release workflows load this helper from the workflow revision while
  // building a separately selected source revision. Always target that project.
  const project = path.resolve(process.argv[3] ?? path.join(import.meta.dir, '..'))
  const target = process.argv[2]
  const configPath = path.join(project, 'src-tauri/tauri.macos.conf.json')
  const config = configureMacosSidecars(JSON.parse(await fs.readFile(configPath, 'utf8')), target)
  await stageMlxBundleResources(path.join(project, '.macos-sidecars'),
    target === 'aarch64-apple-darwin' ? path.join(project, 'src-tauri/mlx.metallib') : null)
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 4)}\n`)
}
