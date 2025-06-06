import path from 'path'
import pLimit from 'p-limit'
import {
  docsUrl,
  readProjectManifestOnly,
  tryReadProjectManifest,
} from '@pnpm/cli-utils'
import { type CompletionFunc } from '@pnpm/command'
import { prepareExecutionEnv } from '@pnpm/plugin-commands-env'
import { FILTERING, UNIVERSAL_OPTIONS } from '@pnpm/common-cli-options-help'
import { type Config, types as allTypes, getWorkspaceConcurrency } from '@pnpm/config'
import { PnpmError } from '@pnpm/error'
import { type CheckDepsStatusOptions } from '@pnpm/deps.status'
import {
  runLifecycleHook,
  makeNodeRequireOption,
  type RunLifecycleHookOptions,
} from '@pnpm/lifecycle'
import { syncInjectedDeps } from '@pnpm/workspace.injected-deps-syncer'
import { type PackageScripts, type ProjectManifest } from '@pnpm/types'
import pick from 'ramda/src/pick'
import realpathMissing from 'realpath-missing'
import renderHelp from 'render-help'
import { runRecursive, type RecursiveRunOpts, getSpecifiedScripts as getSpecifiedScriptWithoutStartCommand } from './runRecursive'
import { existsInDir } from './existsInDir'
import { handler as exec } from './exec'
import { buildCommandNotFoundHint } from './buildCommandNotFoundHint'
import { runDepsStatusCheck } from './runDepsStatusCheck'

export const IF_PRESENT_OPTION: Record<string, unknown> = {
  'if-present': Boolean,
}

export interface DescriptionItem {
  shortAlias?: string
  name: string
  description?: string
}

export const IF_PRESENT_OPTION_HELP: DescriptionItem = {
  description: 'Avoid exiting with a non-zero exit code when the script is undefined',
  name: '--if-present',
}

export const PARALLEL_OPTION_HELP: DescriptionItem = {
  description: 'Completely disregard concurrency and topological sorting, \
running a given script immediately in all matching packages \
with prefixed streaming output. This is the preferred flag \
for long-running processes such as watch run over many packages.',
  name: '--parallel',
}

export const RESUME_FROM_OPTION_HELP: DescriptionItem = {
  description: 'Command executed from given package',
  name: '--resume-from',
}

export const SEQUENTIAL_OPTION_HELP: DescriptionItem = {
  description: 'Run the specified scripts one by one',
  name: '--sequential',
}

export const REPORT_SUMMARY_OPTION_HELP: DescriptionItem = {
  description: 'Save the execution results of every package to "pnpm-exec-summary.json". Useful to inspect the execution time and status of each package.',
  name: '--report-summary',
}

export const REPORTER_HIDE_PREFIX_HELP: DescriptionItem = {
  description: 'Hide project name prefix from output of running scripts. Useful when running in CI like GitHub Actions and the output from a script may create an annotation.',
  name: '--reporter-hide-prefix',
}

export const shorthands: Record<string, string[]> = {
  parallel: [
    '--workspace-concurrency=Infinity',
    '--no-sort',
    '--stream',
    '--recursive',
  ],
  sequential: [
    '--workspace-concurrency=1',
  ],
}

export function rcOptionsTypes (): Record<string, unknown> {
  return {
    ...pick([
      'npm-path',
      'use-node-version',
    ], allTypes),
  }
}

export function cliOptionsTypes (): Record<string, unknown> {
  return {
    ...pick([
      'bail',
      'sort',
      'unsafe-perm',
      'use-node-version',
      'workspace-concurrency',
      'scripts-prepend-node-path',
    ], allTypes),
    ...IF_PRESENT_OPTION,
    recursive: Boolean,
    reverse: Boolean,
    'resume-from': String,
    'report-summary': Boolean,
    'reporter-hide-prefix': Boolean,
  }
}

export const completion: CompletionFunc = async (cliOpts, params) => {
  if (params.length > 0) {
    return []
  }
  const manifest = await readProjectManifestOnly(cliOpts.dir as string ?? process.cwd(), cliOpts)
  return Object.keys(manifest.scripts ?? {}).map((name) => ({ name }))
}

export const commandNames = ['run', 'run-script']

export function help (): string {
  return renderHelp({
    aliases: ['run-script'],
    description: 'Runs a defined package script.',
    descriptionLists: [
      {
        title: 'Options',

        list: [
          {
            description: 'Run the defined package script in every package found in subdirectories \
or every workspace package, when executed inside a workspace. \
For options that may be used with `-r`, see "pnpm help recursive"',
            name: '--recursive',
            shortAlias: '-r',
          },
          {
            description: 'The command will exit with a 0 exit code even if the script fails',
            name: '--no-bail',
          },
          IF_PRESENT_OPTION_HELP,
          PARALLEL_OPTION_HELP,
          RESUME_FROM_OPTION_HELP,
          ...UNIVERSAL_OPTIONS,
          SEQUENTIAL_OPTION_HELP,
          REPORT_SUMMARY_OPTION_HELP,
          REPORTER_HIDE_PREFIX_HELP,
        ],
      },
      FILTERING,
    ],
    url: docsUrl('run'),
    usages: ['pnpm run <command> [<args>...]'],
  })
}

export type RunOpts =
  & Omit<RecursiveRunOpts, 'allProjects' | 'selectedProjectsGraph' | 'workspaceDir'>
  & { recursive?: boolean }
  & Pick<Config,
  | 'bin'
  | 'verifyDepsBeforeRun'
  | 'dir'
  | 'enablePrePostScripts'
  | 'engineStrict'
  | 'executionEnv'
  | 'extraBinPaths'
  | 'extraEnv'
  | 'nodeOptions'
  | 'pnpmHomeDir'
  | 'reporter'
  | 'scriptShell'
  | 'scriptsPrependNodePath'
  | 'shellEmulator'
  | 'syncInjectedDepsAfterScripts'
  | 'userAgent'
  >
  & (
    | { recursive?: false } & Partial<Pick<Config, 'allProjects' | 'selectedProjectsGraph' | 'workspaceDir'>>
    | { recursive: true } & Required<Pick<Config, 'allProjects' | 'selectedProjectsGraph' | 'workspaceDir'>>
  )
  & {
    argv?: {
      original: string[]
    }
    fallbackCommandUsed?: boolean
  }
  & CheckDepsStatusOptions

export async function handler (
  opts: RunOpts,
  params: string[]
): Promise<string | { exitCode: number } | undefined> {
  let dir: string
  if (opts.fallbackCommandUsed && (params[0] === 't' || params[0] === 'tst')) {
    params[0] = 'test'
  }
  const [scriptName, ...passedThruArgs] = params

  if (opts.verifyDepsBeforeRun) {
    await runDepsStatusCheck(opts)
  }

  if (opts.nodeOptions) {
    opts.extraEnv = {
      ...opts.extraEnv,
      NODE_OPTIONS: opts.nodeOptions,
    }
  }

  if (opts.recursive) {
    if (scriptName || Object.keys(opts.selectedProjectsGraph).length > 1) {
      return runRecursive(params, opts) as Promise<undefined>
    }
    dir = Object.keys(opts.selectedProjectsGraph)[0]
  } else {
    dir = opts.dir
  }
  const manifest = await readProjectManifestOnly(dir, opts)
  if (!scriptName) {
    const rootManifest = opts.workspaceDir && opts.workspaceDir !== dir
      ? (await tryReadProjectManifest(opts.workspaceDir, opts)).manifest
      : undefined
    return printProjectCommands(manifest, rootManifest ?? undefined)
  }

  const specifiedScripts = getSpecifiedScripts(manifest.scripts ?? {}, scriptName)

  if (specifiedScripts.length < 1) {
    if (opts.ifPresent) return
    if (opts.fallbackCommandUsed) {
      if (opts.argv == null) throw new Error('Could not fallback because opts.argv.original was not passed to the script runner')
      const params = opts.argv.original.slice(1)
      while (params.length > 0 && params[0].startsWith('-') && params[0] !== '--') {
        params.shift()
      }
      if (params.length > 0 && params[0] === '--') {
        params.shift()
      }
      if (params.length === 0) {
        throw new PnpmError('UNEXPECTED_BEHAVIOR', 'Params should not be an empty array', {
          hint: 'This was a bug caused by programmer error. Please report it',
        })
      }
      return exec({
        selectedProjectsGraph: {},
        implicitlyFellbackFromRun: true,
        ...opts,
      }, params)
    }
    if (opts.workspaceDir) {
      const { manifest: rootManifest } = await tryReadProjectManifest(opts.workspaceDir, opts)
      if (getSpecifiedScripts(rootManifest?.scripts ?? {}, scriptName).length > 0 && specifiedScripts.length < 1) {
        throw new PnpmError('NO_SCRIPT', `Missing script: ${scriptName}`, {
          hint: `But script matched with ${scriptName} is present in the root of the workspace,
so you may run "pnpm -w run ${scriptName}"`,
        })
      }
    }

    throw new PnpmError('NO_SCRIPT', `Missing script: ${scriptName}`, {
      hint: buildCommandNotFoundHint(scriptName, manifest.scripts),
    })
  }
  const concurrency = getWorkspaceConcurrency(opts.workspaceConcurrency)

  const lifecycleOpts: RunLifecycleHookOptions = {
    depPath: dir,
    extraBinPaths: opts.extraBinPaths,
    extraEnv: opts.extraEnv,
    pkgRoot: dir,
    rawConfig: opts.rawConfig,
    rootModulesDir: await realpathMissing(path.join(dir, 'node_modules')),
    scriptsPrependNodePath: opts.scriptsPrependNodePath,
    scriptShell: opts.scriptShell,
    silent: opts.reporter === 'silent',
    shellEmulator: opts.shellEmulator,
    stdio: (specifiedScripts.length > 1 && concurrency > 1) ? 'pipe' : 'inherit',
    unsafePerm: true, // when running scripts explicitly, assume that they're trusted.
  }
  if (opts.executionEnv != null) {
    lifecycleOpts.extraBinPaths = (await prepareExecutionEnv(opts, { executionEnv: opts.executionEnv })).extraBinPaths
  }
  const existsPnp = existsInDir.bind(null, '.pnp.cjs')
  const pnpPath = (opts.workspaceDir && existsPnp(opts.workspaceDir)) ?? existsPnp(dir)
  if (pnpPath) {
    lifecycleOpts.extraEnv = {
      ...lifecycleOpts.extraEnv,
      ...makeNodeRequireOption(pnpPath),
    }
  }
  try {
    const limitRun = pLimit(concurrency)

    const runScriptOptions: RunScriptOptions = {
      enablePrePostScripts: opts.enablePrePostScripts ?? false,
      syncInjectedDepsAfterScripts: opts.syncInjectedDepsAfterScripts,
      workspaceDir: opts.workspaceDir,
    }
    const _runScript = runScript.bind(null, { manifest, lifecycleOpts, runScriptOptions, passedThruArgs })

    await Promise.all(specifiedScripts.map(script => limitRun(() => _runScript(script))))
  } catch (err: unknown) {
    if (opts.bail !== false) {
      throw err
    }
  }
  return undefined
}

const ALL_LIFECYCLE_SCRIPTS = new Set([
  'prepublish',
  'prepare',
  'prepublishOnly',
  'prepack',
  'postpack',
  'publish',
  'postpublish',
  'preinstall',
  'install',
  'postinstall',
  'preuninstall',
  'uninstall',
  'postuninstall',
  'preversion',
  'version',
  'postversion',
  'pretest',
  'test',
  'posttest',
  'prestop',
  'stop',
  'poststop',
  'prestart',
  'start',
  'poststart',
  'prerestart',
  'restart',
  'postrestart',
  'preshrinkwrap',
  'shrinkwrap',
  'postshrinkwrap',
])

function printProjectCommands (
  manifest: ProjectManifest,
  rootManifest?: ProjectManifest
): string {
  const lifecycleScripts = [] as string[][]
  const otherScripts = [] as string[][]

  for (const [scriptName, script] of Object.entries(manifest.scripts ?? {})) {
    if (ALL_LIFECYCLE_SCRIPTS.has(scriptName)) {
      lifecycleScripts.push([scriptName, script])
    } else {
      otherScripts.push([scriptName, script])
    }
  }

  if (lifecycleScripts.length === 0 && otherScripts.length === 0) {
    return 'There are no scripts specified.'
  }

  let output = ''
  if (lifecycleScripts.length > 0) {
    output += `Lifecycle scripts:\n${renderCommands(lifecycleScripts)}`
  }
  if (otherScripts.length > 0) {
    if (output !== '') output += '\n\n'
    output += `Commands available via "pnpm run":\n${renderCommands(otherScripts)}`
  }
  if ((rootManifest?.scripts) == null) {
    return output
  }
  const rootScripts = Object.entries(rootManifest.scripts)
  if (rootScripts.length === 0) {
    return output
  }
  if (output !== '') output += '\n\n'
  output += `Commands of the root workspace project (to run them, use "pnpm -w run"):
${renderCommands(rootScripts)}`
  return output
}

export interface RunScriptOptions {
  enablePrePostScripts: boolean
  syncInjectedDepsAfterScripts: string[] | undefined
  workspaceDir: string | undefined
}

export async function runScript (opts: {
  manifest: ProjectManifest
  lifecycleOpts: RunLifecycleHookOptions
  runScriptOptions: RunScriptOptions
  passedThruArgs: string[]
}, scriptName: string): Promise<void> {
  if (
    opts.runScriptOptions.enablePrePostScripts &&
    opts.manifest.scripts?.[`pre${scriptName}`] &&
    !opts.manifest.scripts[scriptName].includes(`pre${scriptName}`)
  ) {
    await runLifecycleHook(`pre${scriptName}`, opts.manifest, opts.lifecycleOpts)
  }
  await runLifecycleHook(scriptName, opts.manifest, { ...opts.lifecycleOpts, args: opts.passedThruArgs })
  if (
    opts.runScriptOptions.enablePrePostScripts &&
    opts.manifest.scripts?.[`post${scriptName}`] &&
    !opts.manifest.scripts[scriptName].includes(`post${scriptName}`)
  ) {
    await runLifecycleHook(`post${scriptName}`, opts.manifest, opts.lifecycleOpts)
  }
  if (opts.runScriptOptions.syncInjectedDepsAfterScripts?.includes(scriptName)) {
    await syncInjectedDeps({
      pkgName: opts.manifest.name,
      pkgRootDir: opts.lifecycleOpts.pkgRoot,
      workspaceDir: opts.runScriptOptions.workspaceDir,
    })
  }
}

function renderCommands (commands: string[][]): string {
  return commands.map(([scriptName, script]) => `  ${scriptName}\n    ${script}`).join('\n')
}

function getSpecifiedScripts (scripts: PackageScripts, scriptName: string): string[] {
  const specifiedSelector = getSpecifiedScriptWithoutStartCommand(scripts, scriptName)

  if (specifiedSelector.length > 0) {
    return specifiedSelector
  }

  // if a user passes start command as scriptName, `node server.js` will be executed as a fallback, so return start command even if start command is not defined in package.json
  if (scriptName === 'start') {
    return [scriptName]
  }

  return []
}
