// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { test, expect } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { configureMacosSidecars, stageMlxBundleResources } from './macos_bundle_sidecars.js'

test('MLX keeps its runtime lookup through an in-bundle resource link', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'screenpipe-metal-'))
  try {
    const source = path.join(root, 'shader')
    await fs.writeFile(source, 'shader bytes')
    const bundle = path.join(root, 'Contents')
    await stageMlxBundleResources(bundle, source)
    const lookup = path.join(bundle, 'MacOS/mlx.metallib')
    expect(await fs.readlink(lookup)).toBe('../Resources/mlx.metallib')
    expect(await fs.readFile(lookup, 'utf8')).toBe('shader bytes')
    await stageMlxBundleResources(bundle, null)
    expect(await fs.lstat(lookup).catch(() => null)).toBeNull()
    expect(await fs.stat(path.join(bundle, 'Resources/mlx.metallib')).catch(() => null)).toBeNull()
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('release editions share the resource layout without losing localization or Intel ONNX', () => {
  const config = { bundle: { externalBin: ['bun', 'mlx.metallib'], macOS: { files: { Resources: '../.localization/macos-resources' } as Record<string, string> } } }
  configureMacosSidecars(config, 'aarch64-apple-darwin')
  expect(config.bundle.externalBin).toEqual(['bun'])
  expect(config.bundle.macOS.files['.']).toBe('../.macos-sidecars')
  expect(config.bundle.macOS.files.Resources).toBe('../.localization/macos-resources')
  configureMacosSidecars(config, 'x86_64-apple-darwin')
  expect(config.bundle.macOS.files['MacOS/libonnxruntime.dylib']).toBe('libonnxruntime.dylib')
  configureMacosSidecars(config, 'aarch64-apple-darwin')
  expect(config.bundle.macOS.files['MacOS/libonnxruntime.dylib']).toBeUndefined()
  expect(() => configureMacosSidecars(config, 'unknown')).toThrow()
})


test('workflow helper stages and configures the selected source checkout', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'screenpipe-metal-cli-'))
  try {
    const native = path.join(root, 'src-tauri')
    await fs.mkdir(native)
    await fs.writeFile(path.join(native, 'mlx.metallib'), 'selected shader')
    await fs.writeFile(path.join(native, 'tauri.macos.conf.json'), JSON.stringify({ bundle: { externalBin: ['mlx.metallib'] } }))
    const run = Bun.spawnSync([process.execPath, path.join(import.meta.dir, 'macos_bundle_sidecars.js'), 'aarch64-apple-darwin', root])
    expect(run.exitCode).toBe(0)
    const config = JSON.parse(await fs.readFile(path.join(native, 'tauri.macos.conf.json'), 'utf8'))
    expect(config.bundle.externalBin).toEqual([])
    expect(await fs.readFile(path.join(root, '.macos-sidecars/MacOS/mlx.metallib'), 'utf8')).toBe('selected shader')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
