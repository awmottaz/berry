import {MessageName, Project, FetchResult, Installer, LocatorHash, Descriptor, DependencyMeta} from '@yarnpkg/core';
import {Linker, LinkOptions, MinimalLinkOptions, LinkType}                                     from '@yarnpkg/core';
import {Locator, Package, FinalizeInstallStatus}                                               from '@yarnpkg/core';
import {structUtils, Report, Manifest, miscUtils}                                              from '@yarnpkg/core';
import {VirtualFS, ZipOpenFS, xfs, FakeFS, NativePath}                                         from '@yarnpkg/fslib';
import {PortablePath, npath, ppath, toFilename, Filename}                                      from '@yarnpkg/fslib';
import {getLibzipPromise}                                                                      from '@yarnpkg/libzip';
import {parseSyml}                                                                             from '@yarnpkg/parsers';
import {jsInstallUtils}                                                                        from '@yarnpkg/plugin-pnp';
import {NodeModulesLocatorMap, buildLocatorMap, NodeModulesHoistingLimits}                     from '@yarnpkg/pnpify';
import {buildNodeModulesTree}                                                                  from '@yarnpkg/pnpify';
import {PnpApi, PackageInformation}                                                            from '@yarnpkg/pnp';
import cmdShim                                                                                 from '@zkochan/cmd-shim';
import {UsageError}                                                                            from 'clipanion';
import fs                                                                                      from 'fs';

const STATE_FILE_VERSION = 1;
const NODE_MODULES = `node_modules` as Filename;
const DOT_BIN = `.bin` as Filename;
const INSTALL_STATE_FILE = `.yarn-state.yml` as Filename;

type InstallState = {locatorMap: NodeModulesLocatorMap, locationTree: LocationTree, binSymlinks: BinSymlinkMap};
type BinSymlinkMap = Map<PortablePath, Map<Filename, PortablePath>>;
type LoadManifest = (locator: LocatorKey, installLocation: PortablePath) => Promise<Pick<Manifest, 'bin'>>;

export class NodeModulesLinker implements Linker {
  private installStateCache: Map<string, Promise<InstallState | null>> = new Map();

  supportsPackage(pkg: Package, opts: MinimalLinkOptions) {
    return opts.project.configuration.get(`nodeLinker`) === `node-modules`;
  }

  async findPackageLocation(locator: Locator, opts: LinkOptions) {
    const workspace = opts.project.tryWorkspaceByLocator(locator);
    if (workspace)
      return workspace.cwd;

    const installState = await miscUtils.getFactoryWithDefault(this.installStateCache, opts.project.cwd, async () => {
      return await findInstallState(opts.project, {unrollAliases: true});
    });

    if (installState === null)
      throw new UsageError(`Couldn't find the node_modules state file - running an install might help (findPackageLocation)`);

    const locatorInfo = installState.locatorMap.get(structUtils.stringifyLocator(locator));
    if (!locatorInfo) {
      const err = new UsageError(`Couldn't find ${structUtils.prettyLocator(opts.project.configuration, locator)} in the currently installed node_modules map - running an install might help`);
      (err as any).code = `LOCATOR_NOT_INSTALLED`;
      throw err;
    }

    return locatorInfo.locations[0];
  }

  async findPackageLocator(location: PortablePath, opts: LinkOptions) {
    const installState = await miscUtils.getFactoryWithDefault(this.installStateCache, opts.project.cwd, async () => {
      return await findInstallState(opts.project, {unrollAliases: true});
    });

    if (installState === null)
      return null;

    const {locationRoot, segments} = parseLocation(ppath.resolve(location), {skipPrefix: opts.project.cwd});

    let locationNode = installState.locationTree.get(locationRoot);
    if (!locationNode)
      return null;

    let locator = locationNode.locator!;
    for (const segment of segments) {
      locationNode = locationNode.children.get(segment);
      if (!locationNode)
        break;
      locator = locationNode.locator || locator;
    }

    return structUtils.parseLocator(locator);
  }

  makeInstaller(opts: LinkOptions) {
    return new NodeModulesInstaller(opts);
  }
}

class NodeModulesInstaller implements Installer {
  // Stores data that we need to extract in the `installPackage` step but use
  // in the `finalizeInstall` step. Contrary to custom data this isn't persisted
  // anywhere - we literally just use it for the lifetime of the installer then
  // discard it.
  private localStore: Map<LocatorHash, {
    pkg: Package,
    customPackageData: CustomPackageData,
    dependencyMeta: DependencyMeta,
    pnpNode: PackageInformation<NativePath>,
  }> = new Map();

  constructor(private opts: LinkOptions) {
    // Nothing to do
  }

  getCustomDataKey() {
    return JSON.stringify({
      name: `NodeModulesInstaller`,
      version: 1,
    });
  }

  private customData: {
    store: Map<LocatorHash, CustomPackageData>,
  } = {
    store: new Map(),
  };

  attachCustomData(customData: any) {
    this.customData = customData;
  }

  async installPackage(pkg: Package, fetchResult: FetchResult) {
    const packageLocation = ppath.resolve(fetchResult.packageFs.getRealPath(), fetchResult.prefixPath);

    let customPackageData = this.customData.store.get(pkg.locatorHash);
    if (typeof customPackageData === `undefined`) {
      customPackageData = await extractCustomPackageData(pkg, fetchResult);
      if (pkg.linkType === LinkType.HARD) {
        this.customData.store.set(pkg.locatorHash, customPackageData);
      }
    }

    // We don't link the package at all if it's for an unsupported platform
    if (!jsInstallUtils.checkAndReportManifestCompatibility(pkg, customPackageData, `link`, {configuration: this.opts.project.configuration, report: this.opts.report}))
      return {packageLocation: null, buildDirective: null};

    const packageDependencies = new Map<string, string | [string, string] | null>();
    const packagePeers = new Set<string>();

    if (!packageDependencies.has(structUtils.stringifyIdent(pkg)))
      packageDependencies.set(structUtils.stringifyIdent(pkg), pkg.reference);

    // Only virtual packages should have effective peer dependencies, but the
    // workspaces are a special case because the original packages are kept in
    // the dependency tree even after being virtualized; so in their case we
    // just ignore their declared peer dependencies.
    if (structUtils.isVirtualLocator(pkg)) {
      for (const descriptor of pkg.peerDependencies.values()) {
        packageDependencies.set(structUtils.stringifyIdent(descriptor), null);
        packagePeers.add(structUtils.stringifyIdent(descriptor));
      }
    }

    const pnpNode: PackageInformation<NativePath> = {
      packageLocation: `${npath.fromPortablePath(packageLocation)}/`,
      packageDependencies,
      packagePeers,
      linkType: pkg.linkType,
      discardFromLookup: fetchResult.discardFromLookup ?? false,
    };

    this.localStore.set(pkg.locatorHash, {
      pkg,
      customPackageData,
      dependencyMeta: this.opts.project.getDependencyMeta(pkg, pkg.version),
      pnpNode,
    });

    return {
      packageLocation,
      buildDirective: null,
    };
  }

  async attachInternalDependencies(locator: Locator, dependencies: Array<[Descriptor, Locator]>) {
    const slot = this.localStore.get(locator.locatorHash);
    if (typeof slot === `undefined`)
      throw new Error(`Assertion failed: Expected information object to have been registered`);

    for (const [descriptor, locator] of dependencies) {
      const target = !structUtils.areIdentsEqual(descriptor, locator)
        ? [structUtils.stringifyIdent(locator), locator.reference] as [string, string]
        : locator.reference;

      slot.pnpNode.packageDependencies.set(structUtils.stringifyIdent(descriptor), target);
    }
  }

  async attachExternalDependents(locator: Locator, dependentPaths: Array<PortablePath>) {
    throw new Error(`External dependencies haven't been implemented for the node-modules linker`);
  }

  async finalizeInstall() {
    if (this.opts.project.configuration.get(`nodeLinker`) !== `node-modules`)
      return undefined;

    const defaultFsLayer = new VirtualFS({
      baseFs: new ZipOpenFS({
        libzip: await getLibzipPromise(),
        maxOpenFiles: 80,
        readOnlyArchives: true,
      }),
    });

    let preinstallState = await findInstallState(this.opts.project);

    // Remove build state as well, to force rebuild of all the packages
    if (preinstallState === null) {
      this.opts.project.storedBuildState.clear();

      preinstallState = {locatorMap: new Map(), binSymlinks: new Map(), locationTree: new Map()};
    }

    const hoistingLimitsByCwd = new Map(this.opts.project.workspaces.map(workspace => {
      let hoistingLimits = this.opts.project.configuration.get(`nmHoistingLimits`);
      try {
        hoistingLimits = miscUtils.validateEnum(NodeModulesHoistingLimits, workspace.manifest.installConfig?.hoistingLimits ?? hoistingLimits);
      } catch (e) {
        const workspaceName = structUtils.prettyWorkspace(this.opts.project.configuration, workspace);
        this.opts.report.reportWarning(MessageName.INVALID_MANIFEST, `${workspaceName}: Invalid 'installConfig.hoistingLimits' value. Expected one of ${Object.values(NodeModulesHoistingLimits).join(`, `)}, using default: "${hoistingLimits}"`);
      }
      return [workspace.relativeCwd, hoistingLimits];
    }));

    const pnpApi: PnpApi = {
      VERSIONS: {
        std: 1,
      },
      topLevel: {
        name: null,
        reference: null,
      },
      getLocator: (name, referencish) => {
        if (Array.isArray(referencish)) {
          return {name: referencish[0], reference: referencish[1]};
        } else {
          return {name, reference: referencish};
        }
      },
      getDependencyTreeRoots: () => {
        return this.opts.project.workspaces.map(workspace => {
          const anchoredLocator = workspace.anchoredLocator;
          return {name: structUtils.stringifyIdent(workspace.locator), reference: anchoredLocator.reference};
        });
      },
      getPackageInformation: pnpLocator => {
        const locator = pnpLocator.reference === null
          ? this.opts.project.topLevelWorkspace.anchoredLocator
          : structUtils.makeLocator(structUtils.parseIdent(pnpLocator.name), pnpLocator.reference);

        const slot = this.localStore.get(locator.locatorHash);
        if (typeof slot === `undefined`)
          throw new Error(`Assertion failed: Expected the package reference to have been registered`);

        return slot.pnpNode;
      },
      findPackageLocator: location => {
        const workspace = this.opts.project.tryWorkspaceByCwd(npath.toPortablePath(location));
        if (workspace !== null) {
          const anchoredLocator = workspace.anchoredLocator;
          return {name: structUtils.stringifyIdent(anchoredLocator), reference: anchoredLocator.reference};
        }

        throw new Error(`Assertion failed: Unimplemented`);
      },
      resolveToUnqualified: () => {
        throw new Error(`Assertion failed: Unimplemented`);
      },
      resolveUnqualified: () => {
        throw new Error(`Assertion failed: Unimplemented`);
      },
      resolveRequest: () => {
        throw new Error(`Assertion failed: Unimplemented`);
      },
      resolveVirtual: path => {
        return npath.fromPortablePath(VirtualFS.resolveVirtual(npath.toPortablePath(path)));
      },
    };

    const nmTree = buildNodeModulesTree(pnpApi, {pnpifyFs: false, hoistingLimitsByCwd, project: this.opts.project});
    const locatorMap = buildLocatorMap(nmTree);

    await persistNodeModules(preinstallState, locatorMap, {
      baseFs: defaultFsLayer,
      project: this.opts.project,
      report: this.opts.report,
      loadManifest: async locatorKey => {
        const locator = structUtils.parseLocator(locatorKey);

        const slot = this.localStore.get(locator.locatorHash);
        if (typeof slot === `undefined`)
          throw new Error(`Assertion failed: Expected the slot to exist`);

        return slot.customPackageData.manifest;
      },
    });

    const installStatuses: Array<FinalizeInstallStatus> = [];

    for (const [locatorKey, installRecord] of locatorMap.entries()) {
      if (isLinkLocator(locatorKey))
        continue;

      const locator = structUtils.parseLocator(locatorKey);
      const slot = this.localStore.get(locator.locatorHash);
      if (typeof slot === `undefined`)
        throw new Error(`Assertion failed: Expected the slot to exist`);

      // Workspaces are built by the core
      if (this.opts.project.tryWorkspaceByLocator(slot.pkg))
        continue;

      const buildScripts = jsInstallUtils.extractBuildScripts(slot.pkg, slot.customPackageData, slot.dependencyMeta, {configuration: this.opts.project.configuration, report: this.opts.report});
      if (buildScripts.length === 0)
        continue;

      installStatuses.push({
        buildLocations: installRecord.locations,
        locatorHash: locator.locatorHash,
        buildDirective: buildScripts,
      });
    }

    return {
      customData: this.customData,
      records: installStatuses,
    };
  }
}


type UnboxPromise<T extends Promise<any>> = T extends Promise<infer U> ? U: never;
type CustomPackageData = UnboxPromise<ReturnType<typeof extractCustomPackageData>>;

async function extractCustomPackageData(pkg: Package, fetchResult: FetchResult) {
  const manifest = await Manifest.tryFind(fetchResult.prefixPath, {baseFs: fetchResult.packageFs}) ?? new Manifest();

  const preservedScripts = new Set([`preinstall`, `install`, `postinstall`]);
  for (const scriptName of manifest.scripts.keys())
    if (!preservedScripts.has(scriptName))
      manifest.scripts.delete(scriptName);

  return {
    manifest: {
      bin: manifest.bin,
      os: manifest.os,
      cpu: manifest.cpu,
      scripts: manifest.scripts,
    },
    misc: {
      extractHint: jsInstallUtils.getExtractHint(fetchResult),
      hasBindingGyp: jsInstallUtils.hasBindingGyp(fetchResult),
    },
  };
}

async function writeInstallState(project: Project, locatorMap: NodeModulesLocatorMap, binSymlinks: BinSymlinkMap) {
  let locatorState = ``;

  locatorState += `# Warning: This file is automatically generated. Removing it is fine, but will\n`;
  locatorState += `# cause your node_modules installation to become invalidated.\n`;
  locatorState += `\n`;
  locatorState += `__metadata:\n`;
  locatorState += `  version: ${STATE_FILE_VERSION}\n`;

  const locators = Array.from(locatorMap.keys()).sort();
  const topLevelLocator = structUtils.stringifyLocator(project.topLevelWorkspace.anchoredLocator);

  for (const locator of locators) {
    const installRecord = locatorMap.get(locator)!;
    locatorState += `\n`;
    locatorState += `${JSON.stringify(locator)}:\n`;
    locatorState += `  locations:\n`;

    for (const location of installRecord.locations) {
      const internalPath = ppath.contains(project.cwd, location);
      if (internalPath === null)
        throw new Error(`Assertion failed: Expected the path to be within the project (${location})`);

      locatorState += `    - ${JSON.stringify(internalPath)}\n`;
    }

    if (installRecord.aliases.length > 0) {
      locatorState += `  aliases:\n`;
      for (const alias of installRecord.aliases) {
        locatorState += `    - ${JSON.stringify(alias)}\n`;
      }
    }

    if (locator === topLevelLocator && binSymlinks.size > 0) {
      locatorState += `  bin:\n`;
      for (const [location, symlinks] of binSymlinks) {
        const internalPath = ppath.contains(project.cwd, location);
        if (internalPath === null)
          throw new Error(`Assertion failed: Expected the path to be within the project (${location})`);

        locatorState += `    ${JSON.stringify(internalPath)}:\n`;
        for (const [name, target] of symlinks) {
          const relativePath = ppath.relative(ppath.join(location, NODE_MODULES), target);
          locatorState += `      ${JSON.stringify(name)}: ${JSON.stringify(relativePath)}\n`;
        }
      }
    }
  }

  const rootPath = project.cwd;
  const installStatePath = ppath.join(rootPath, NODE_MODULES, INSTALL_STATE_FILE);

  await xfs.changeFilePromise(installStatePath, locatorState, {
    automaticNewlines: true,
  });
}

async function findInstallState(project: Project, {unrollAliases = false}: {unrollAliases?: boolean} = {}): Promise<InstallState | null> {
  const rootPath = project.cwd;
  const installStatePath = ppath.join(rootPath, NODE_MODULES, INSTALL_STATE_FILE);

  if (!xfs.existsSync(installStatePath))
    return null;

  const locatorState = parseSyml(await xfs.readFilePromise(installStatePath, `utf8`));

  // If we have a higher serialized version than we can handle, ignore the state alltogether
  if (locatorState.__metadata.version > STATE_FILE_VERSION)
    return null;

  const locatorMap: NodeModulesLocatorMap = new Map();
  const binSymlinks: BinSymlinkMap = new Map();

  delete locatorState.__metadata;

  for (const [locatorStr, installRecord] of Object.entries(locatorState)) {
    const locations = installRecord.locations.map((location: PortablePath) => {
      return ppath.join(rootPath, location);
    });

    const recordSymlinks = installRecord.bin;
    if (recordSymlinks) {
      for (const [relativeLocation, locationSymlinks] of Object.entries(recordSymlinks)) {
        const location = ppath.join(rootPath, npath.toPortablePath(relativeLocation));
        const symlinks = miscUtils.getMapWithDefault(binSymlinks, location);
        for (const [name, target] of Object.entries(locationSymlinks as any)) {
          symlinks.set(toFilename(name), npath.toPortablePath([location, NODE_MODULES, target].join(ppath.delimiter)));
        }
      }
    }

    locatorMap.set(locatorStr, {
      target: PortablePath.dot,
      linkType: LinkType.HARD,
      locations,
      aliases: installRecord.aliases || [],
    });

    if (unrollAliases && installRecord.aliases) {
      for (const reference of installRecord.aliases) {
        const {scope, name} = structUtils.parseLocator(locatorStr);

        const alias = structUtils.makeLocator(structUtils.makeIdent(scope, name), reference);
        const aliasStr = structUtils.stringifyLocator(alias);

        locatorMap.set(aliasStr, {
          target: PortablePath.dot,
          linkType: LinkType.HARD,
          locations,
          aliases: [],
        });
      }
    }
  }

  return {locatorMap, binSymlinks, locationTree: buildLocationTree(locatorMap, {skipPrefix: project.cwd})};
}

const removeDir = async (dir: PortablePath, options: {contentsOnly: boolean, innerLoop?: boolean}): Promise<any> => {
  if (dir.split(ppath.sep).indexOf(NODE_MODULES) < 0)
    throw new Error(`Assertion failed: trying to remove dir that doesn't contain node_modules: ${dir}`);

  try {
    if (!options.innerLoop) {
      const stats = await xfs.lstatPromise(dir);
      if (stats.isSymbolicLink()) {
        await xfs.unlinkPromise(dir);
        return;
      }
    }
    const entries = await xfs.readdirPromise(dir, {withFileTypes: true});
    for (const entry of entries) {
      const targetPath = ppath.join(dir, toFilename(entry.name));
      if (entry.isDirectory()) {
        if (entry.name !== NODE_MODULES || (options && options.innerLoop)) {
          await removeDir(targetPath, {innerLoop: true, contentsOnly: false});
        }
      } else {
        await xfs.unlinkPromise(targetPath);
      }
    }
    if (!options.contentsOnly) {
      await xfs.rmdirPromise(dir);
    }
  } catch (e) {
    if (e.code !== `ENOENT` && e.code !== `ENOTEMPTY`) {
      throw e;
    }
  }
};

const CONCURRENT_OPERATION_LIMIT = 4;

type LocatorKey = string;
type LocationNode = { children: Map<Filename, LocationNode>, locator?: LocatorKey, linkType: LinkType };
type LocationRoot = PortablePath;

/**
 * Locations tree. It starts with the map of location roots and continues as maps
 * of nested directory entries.
 *
 * Example:
 *  Map {
 *   '' => children: Map {
 *     'react-apollo' => {
 *       children: Map {
 *         'node_modules' => {
 *           children: Map {
 *             '@apollo' => {
 *               children: Map {
 *                 'react-hooks' => {
 *                   children: Map {},
 *                   locator: '@apollo/react-hooks:virtual:cf...#npm:3.1.3'
 *                 }
 *               }
 *             }
 *           }
 *         }
 *       },
 *       locator: 'react-apollo:virtual:24...#npm:3.1.3'
 *     },
 *   },
 *   'packages/client' => children: Map {
 *     'node_modules' => Map {
 *       ...
 *     }
 *   }
 *   ...
 * }
 */
type LocationTree = Map<LocationRoot, LocationNode>;

const parseLocation = (location: PortablePath, {skipPrefix}: {skipPrefix: PortablePath}): {locationRoot: PortablePath, segments: Array<Filename>} => {
  const projectRelativePath = ppath.contains(skipPrefix, location);
  if (projectRelativePath === null)
    throw new Error(`Assertion failed: Cannot process a path that isn't part of the requested prefix (${location} isn't within ${skipPrefix})`);

  const allSegments = projectRelativePath
    .split(ppath.sep)
    // Ignore empty segments (after trailing slashes)
    .filter(segment => segment !== ``);
  const nmIndex = allSegments.indexOf(NODE_MODULES);

  // Project path, up until the first node_modules segment
  const relativeRoot = allSegments.slice(0, nmIndex).join(ppath.sep) as PortablePath;
  const locationRoot = ppath.join(skipPrefix, relativeRoot);

  // All segments that follow
  const segments = allSegments.slice(nmIndex) as Array<Filename>;

  return {locationRoot, segments};
};

const buildLocationTree = (locatorMap: NodeModulesLocatorMap | null, {skipPrefix}: {skipPrefix: PortablePath}): LocationTree => {
  const locationTree: LocationTree = new Map();
  if (locatorMap === null)
    return locationTree;

  const makeNode: () => LocationNode = () => ({
    children: new Map(),
    linkType: LinkType.HARD,
  });

  for (const [locator, info] of locatorMap.entries()) {
    if (info.linkType === LinkType.SOFT) {
      const internalPath = ppath.contains(skipPrefix, info.target);
      if (internalPath !== null) {
        const node = miscUtils.getFactoryWithDefault(locationTree, info.target, makeNode);
        node.locator = locator;
        node.linkType = info.linkType;
      }
    }

    for (const location of info.locations) {
      const {locationRoot, segments} = parseLocation(location, {skipPrefix});

      let node = miscUtils.getFactoryWithDefault(locationTree, locationRoot, makeNode);

      for (let idx = 0; idx < segments.length; ++idx) {
        const segment = segments[idx];
        // '.' segment exists only for top-level locator, skip it
        if (segment !== `.`) {
          const nextNode = miscUtils.getFactoryWithDefault(node.children, segment, makeNode);

          node.children.set(segment, nextNode);
          node = nextNode;
        }

        if (idx === segments.length - 1) {
          node.locator = locator;
          node.linkType = info.linkType;
        }
      }
    }
  }

  return locationTree;
};

const symlinkPromise = async (srcPath: PortablePath, dstPath: PortablePath) => {
  let stats;

  try {
    if (process.platform === `win32`) {
      stats = await xfs.lstatPromise(srcPath);
    }
  } catch (e) {
  }

  if (process.platform == `win32` && (!stats || stats.isDirectory())) {
    await xfs.symlinkPromise(srcPath, dstPath, `junction`);
  } else {
    await xfs.symlinkPromise(ppath.relative(ppath.dirname(dstPath), srcPath), dstPath);
  }
};

const copyPromise = async (dstDir: PortablePath, srcDir: PortablePath, {baseFs, innerLoop}: {baseFs: FakeFS<PortablePath>, innerLoop?: boolean}) => {
  await xfs.mkdirPromise(dstDir, {recursive: true});
  const entries = await baseFs.readdirPromise(srcDir, {withFileTypes: true});

  const copy = async (dstPath: PortablePath, srcPath: PortablePath, srcType: fs.Dirent) => {
    if (srcType.isFile()) {
      const stat = await baseFs.lstatPromise(srcPath);
      await baseFs.copyFilePromise(srcPath, dstPath);
      const mode = stat.mode & 0o777;
      // An optimization - files will have rw-r-r permissions (0o644) by default, we can skip chmod for them
      if (mode !== 0o644) {
        await xfs.chmodPromise(dstPath, mode);
      }
    } else if (srcType.isSymbolicLink()) {
      const target = await baseFs.readlinkPromise(srcPath);
      await symlinkPromise(ppath.resolve(ppath.dirname(dstPath), target), dstPath);
    } else {
      throw new Error(`Unsupported file type (file: ${srcPath}, mode: 0o${await xfs.statSync(srcPath).mode.toString(8).padStart(6, `0`)})`);
    }
  };

  for (const entry of entries) {
    const srcPath = ppath.join(srcDir, toFilename(entry.name));
    const dstPath = ppath.join(dstDir, toFilename(entry.name));
    if (entry.isDirectory()) {
      if (entry.name !== NODE_MODULES || innerLoop) {
        await copyPromise(dstPath, srcPath, {baseFs, innerLoop: true});
      }
    } else {
      await copy(dstPath, srcPath, entry);
    }
  }
};

/**
 * This function removes node_modules roots that do not exist on the filesystem from the location tree.
 *
 * This is needed to transparently support workflows on CI systems. When
 * user caches only top-level node_modules and forgets to cache node_modules
 * from deeper workspaces. By removing non-existent node_modules roots
 * we make our location tree to represent the real tree on the file system.
 *
 * Please note, that this function doesn't help with any other inconsistency
 * on a deeper level inside node_modules tree, it helps only when some node_modules roots
 * do not exist at all
 *
 * @param locationTree location tree
 *
 * @returns location tree with non-existent node_modules roots stripped
 */
function refineNodeModulesRoots(locationTree: LocationTree, binSymlinks: BinSymlinkMap): {locationTree: LocationTree, binSymlinks: BinSymlinkMap} {
  const refinedLocationTree: LocationTree = new Map([...locationTree]);
  const refinedBinSymlinks: BinSymlinkMap = new Map([...binSymlinks]);

  for (const [workspaceRoot, node] of locationTree) {
    const nodeModulesRoot = ppath.join(workspaceRoot, NODE_MODULES);
    if (!xfs.existsSync(nodeModulesRoot)) {
      node.children.delete(NODE_MODULES);

      // O(m^2) complexity algorithm, but on a very few values, so not worth the trouble to optimize it
      for (const location of refinedBinSymlinks.keys()) {
        if (ppath.contains(nodeModulesRoot, location) !== null) {
          refinedBinSymlinks.delete(location);
        }
      }
    }
  }

  return {locationTree: refinedLocationTree, binSymlinks: refinedBinSymlinks};
}

function isLinkLocator(locatorKey: LocatorKey): boolean {
  let descriptor = structUtils.parseDescriptor(locatorKey);
  if (structUtils.isVirtualDescriptor(descriptor))
    descriptor = structUtils.devirtualizeDescriptor(descriptor);

  return descriptor.range.startsWith(`link:`);
}

async function createBinSymlinkMap(installState: NodeModulesLocatorMap, locationTree: LocationTree, projectRoot: PortablePath, {loadManifest}: {loadManifest: LoadManifest}) {
  const locatorScriptMap = new Map<LocatorKey, Map<string, string>>();
  for (const [locatorKey, {locations}] of installState) {
    const manifest = !isLinkLocator(locatorKey)
      ? await loadManifest(locatorKey, locations[0])
      : null;

    const bin = new Map();
    if (manifest) {
      for (const [name, value] of manifest.bin) {
        const target = ppath.join(locations[0], value);
        if (value !== `` && xfs.existsSync(target)) {
          bin.set(name, value);
        }
      }
    }

    locatorScriptMap.set(locatorKey, bin);
  }

  const binSymlinks: BinSymlinkMap = new Map();

  const getBinSymlinks = (location: PortablePath, parentLocatorLocation: PortablePath, node: LocationNode): Map<Filename, PortablePath> => {
    const symlinks = new Map();
    const internalPath = ppath.contains(projectRoot, location);
    if (node.locator && internalPath !== null) {
      const binScripts = locatorScriptMap.get(node.locator)!;
      for (const [filename, scriptPath] of binScripts) {
        const symlinkTarget = ppath.join(location, npath.toPortablePath(scriptPath));
        symlinks.set(toFilename(filename), symlinkTarget);
      }
      for (const [childLocation, childNode] of node.children) {
        const absChildLocation = ppath.join(location, childLocation);
        const childSymlinks = getBinSymlinks(absChildLocation, absChildLocation, childNode);
        if (childSymlinks.size > 0) {
          binSymlinks.set(location, new Map([...(binSymlinks.get(location) || new Map()), ...childSymlinks]));
        }
      }
    } else {
      for (const [childLocation, childNode] of node.children) {
        const childSymlinks = getBinSymlinks(ppath.join(location, childLocation), parentLocatorLocation, childNode);
        for (const [name, symlinkTarget] of childSymlinks) {
          symlinks.set(name, symlinkTarget);
        }
      }
    }
    return symlinks;
  };

  for (const [location, node] of locationTree) {
    const symlinks = getBinSymlinks(location, location, node);
    if (symlinks.size > 0) {
      binSymlinks.set(location, new Map([...(binSymlinks.get(location) || new Map()), ...symlinks]));
    }
  }

  return binSymlinks;
}

const areRealLocatorsEqual = (locatorKey1?: LocatorKey, locatorKey2?: LocatorKey) => {
  if (!locatorKey1 || !locatorKey2)
    return locatorKey1 === locatorKey2;

  let locator1 = structUtils.parseLocator(locatorKey1);
  if (structUtils.isVirtualLocator(locator1))
    locator1 = structUtils.devirtualizeLocator(locator1);
  let locator2 = structUtils.parseLocator(locatorKey2);
  if (structUtils.isVirtualLocator(locator2))
    locator2 = structUtils.devirtualizeLocator(locator2);

  return structUtils.areLocatorsEqual(locator1, locator2);
};

async function persistNodeModules(preinstallState: InstallState, installState: NodeModulesLocatorMap, {baseFs, project, report, loadManifest}: {project: Project, baseFs: FakeFS<PortablePath>, report: Report, loadManifest: LoadManifest}) {
  const rootNmDirPath = ppath.join(project.cwd, NODE_MODULES);

  const {locationTree: prevLocationTree, binSymlinks: prevBinSymlinks} = refineNodeModulesRoots(preinstallState.locationTree, preinstallState.binSymlinks);
  const locationTree = buildLocationTree(installState, {skipPrefix: project.cwd});

  const addQueue: Array<Promise<void>> = [];
  const addModule = async ({srcDir, dstDir, linkType}: {srcDir: PortablePath, dstDir: PortablePath, linkType: LinkType}) => {
    const promise: Promise<any> = (async () => {
      try {
        if (linkType === LinkType.SOFT) {
          await xfs.mkdirPromise(ppath.dirname(dstDir), {recursive: true});
          await symlinkPromise(ppath.resolve(srcDir), dstDir);
        } else {
          await copyPromise(dstDir, srcDir, {baseFs});
        }
      } catch (e) {
        e.message = `While persisting ${srcDir} -> ${dstDir} ${e.message}`;
        throw e;
      } finally {
        progress.tick();
      }
    })().then(() => addQueue.splice(addQueue.indexOf(promise), 1));
    addQueue.push(promise);
    if (addQueue.length > CONCURRENT_OPERATION_LIMIT) {
      await Promise.race(addQueue);
    }
  };

  const cloneModule = async (srcDir: PortablePath, dstDir: PortablePath, options?: { innerLoop?: boolean }) => {
    const promise: Promise<any> = (async () => {
      const cloneDir = async (srcDir: PortablePath, dstDir: PortablePath, options?: { innerLoop?: boolean }) => {
        try {
          if (!options || !options.innerLoop)
            await xfs.mkdirPromise(dstDir, {recursive: true});

          const entries = await xfs.readdirPromise(srcDir, {withFileTypes: true});
          for (const entry of entries) {
            if ((!options || !options.innerLoop) && entry.name === DOT_BIN)
              continue;

            const src = ppath.join(srcDir, entry.name);
            const dst = ppath.join(dstDir, entry.name);

            if (entry.isDirectory()) {
              if (entry.name !== NODE_MODULES || (options && options.innerLoop)) {
                await xfs.mkdirPromise(dst, {recursive: true});
                await cloneDir(src, dst, {innerLoop: true});
              }
            } else {
              await xfs.copyFilePromise(src, dst, fs.constants.COPYFILE_FICLONE);
            }
          }
        } catch (e) {
          if (!options || !options.innerLoop)
            e.message = `While cloning ${srcDir} -> ${dstDir} ${e.message}`;

          throw e;
        } finally {
          if (!options || !options.innerLoop) {
            progress.tick();
          }
        }
      };

      await cloneDir(srcDir, dstDir, options);
    })().then(() => addQueue.splice(addQueue.indexOf(promise), 1));
    addQueue.push(promise);
    if (addQueue.length > CONCURRENT_OPERATION_LIMIT) {
      await Promise.race(addQueue);
    }
  };

  const removeOutdatedDirs = async (location: PortablePath, prevNode: LocationNode, node?: LocationNode) => {
    if (!node) {
      if (prevNode.children.has(NODE_MODULES))
        await removeDir(ppath.join(location, NODE_MODULES), {contentsOnly: false});

      await removeDir(location, {contentsOnly: location === rootNmDirPath});
    } else {
      for (const [segment, prevChildNode] of prevNode.children) {
        const childNode = node.children.get(segment);
        await removeOutdatedDirs(ppath.join(location, segment), prevChildNode, childNode);
      }
    }
  };

  // Find locations that existed previously, but no longer exist
  for (const [location, prevNode] of prevLocationTree) {
    const node = locationTree.get(location);
    for (const [segment, prevChildNode] of prevNode.children) {
      // '.' segment exists only for top-level locator, skip it
      if (segment === `.`)
        continue;
      const childNode = node ? node.children.get(segment) : node;
      await removeOutdatedDirs(ppath.join(location, segment), prevChildNode, childNode);
    }
  }

  const cleanNewDirs = async (location: PortablePath, node: LocationNode, prevNode?: LocationNode) => {
    if (!prevNode) {
      // We want to clean only contents of top-level node_modules dir, since we need these dirs to be present
      if (node.children.has(NODE_MODULES))
        await removeDir(ppath.join(location, NODE_MODULES), {contentsOnly: true});

      // 1. If old directory is a symlink removeDir will remove it, regardless contentsOnly value
      // 2. If old and new directories are hardlinks - we pass contentsOnly: true
      // so that removeDir cleared only contents
      // 3. If new directory is a symlink - we pass contentsOnly: false
      // so that removeDir removed the whole directory
      await removeDir(location, {contentsOnly: node.linkType === LinkType.HARD});
    } else {
      if (!areRealLocatorsEqual(node.locator, prevNode.locator))
        await removeDir(location, {contentsOnly: node.linkType === LinkType.HARD});

      for (const [segment, childNode] of node.children) {
        const prevChildNode = prevNode.children.get(segment);
        await cleanNewDirs(ppath.join(location, segment), childNode, prevChildNode);
      }
    }
  };

  // Find new locations that are being added/changed and need to be cleaned up first
  for (const [location, node] of locationTree) {
    const prevNode = prevLocationTree.get(location);
    for (const [segment, childNode] of node.children) {
      // '.' segment exists only for top-level locator, skip it
      if (segment === `.`)
        continue;
      const prevChildNode = prevNode ? prevNode.children.get(segment) : prevNode;
      await cleanNewDirs(ppath.join(location, segment), childNode, prevChildNode);
    }
  }

  // Update changed locations
  const addList: Array<{srcDir: PortablePath, dstDir: PortablePath, linkType: LinkType}> = [];
  for (const [prevLocator, {locations}] of preinstallState.locatorMap.entries()) {
    for (const location of locations) {
      const {locationRoot, segments} = parseLocation(location, {
        skipPrefix: project.cwd,
      });

      let node = locationTree.get(locationRoot);
      let curLocation = locationRoot;
      if (node) {
        for (const segment of segments) {
          curLocation = ppath.join(curLocation, segment);
          node = node.children.get(segment);
          if (!node) {
            break;
          }
        }
        if (node && !areRealLocatorsEqual(node.locator, prevLocator)) {
          const info = installState.get(node.locator!)!;
          const srcDir = info.target;
          const dstDir = curLocation;
          const linkType = info.linkType;
          if (srcDir !== dstDir) {
            addList.push({srcDir, dstDir, linkType});
          }
        }
      }
    }
  }

  // Add new locations
  for (const [locator, {locations}] of installState.entries()) {
    for (const location of locations) {
      const {locationRoot, segments} = parseLocation(location, {
        skipPrefix: project.cwd,
      });

      let prevTreeNode = prevLocationTree.get(locationRoot);
      let node = locationTree.get(locationRoot);
      let curLocation = locationRoot;

      const info = installState.get(locator)!;
      const srcDir = info.target;
      const dstDir = location;
      if (srcDir === dstDir)
        continue;

      const linkType = info.linkType;

      for (const segment of segments)
        node = node!.children.get(segment);

      if (!prevTreeNode) {
        addList.push({srcDir, dstDir, linkType});
      } else {
        for (const segment of segments) {
          curLocation = ppath.join(curLocation, segment);
          prevTreeNode = prevTreeNode.children.get(segment);
          if (!prevTreeNode) {
            addList.push({srcDir, dstDir, linkType});
            break;
          }
        }
      }
    }
  }

  const progress = Report.progressViaCounter(addList.length);
  const reportedProgress = report.reportProgress(progress);

  try {
    const persistedLocations = new Map<PortablePath, PortablePath>();

    // For the first pass we'll only want to install a single copy for each
    // source directory. We'll later use the resulting install directories for
    // the other instances of the same package (this will avoid us having to
    // crawl the zip archives for each package).
    for (const entry of addList) {
      if (entry.linkType === LinkType.SOFT || !persistedLocations.has(entry.srcDir)) {
        persistedLocations.set(entry.srcDir, entry.dstDir);
        await addModule({...entry});
      }
    }

    await Promise.all(addQueue);
    addQueue.length = 0;

    // Second pass: clone module duplicates
    for (const entry of addList) {
      const persistedDir = persistedLocations.get(entry.srcDir)!;
      if (entry.linkType !== LinkType.SOFT && entry.dstDir !== persistedDir) {
        await cloneModule(persistedDir, entry.dstDir);
      }
    }

    await Promise.all(addQueue);

    await xfs.mkdirPromise(rootNmDirPath, {recursive: true});

    const binSymlinks = await createBinSymlinkMap(installState, locationTree, project.cwd, {loadManifest});
    await persistBinSymlinks(prevBinSymlinks, binSymlinks);

    await writeInstallState(project, installState, binSymlinks);
  } finally {
    reportedProgress.stop();
  }
}

async function persistBinSymlinks(previousBinSymlinks: BinSymlinkMap, binSymlinks: BinSymlinkMap) {
  // Delete outdated .bin folders
  for (const location of previousBinSymlinks.keys()) {
    if (!binSymlinks.has(location)) {
      const binDir = ppath.join(location, NODE_MODULES, DOT_BIN);
      await xfs.removePromise(binDir);
    }
  }

  for (const [location, symlinks] of binSymlinks) {
    const binDir = ppath.join(location, NODE_MODULES, DOT_BIN);
    const prevSymlinks = previousBinSymlinks.get(location) || new Map();
    await xfs.mkdirPromise(binDir, {recursive: true});
    for (const name of prevSymlinks.keys()) {
      if (!symlinks.has(name)) {
        // Remove outdated symlinks
        await xfs.removePromise(ppath.join(binDir, name));
        if (process.platform === `win32`) {
          await xfs.removePromise(ppath.join(binDir, toFilename(`${name}.cmd`)));
        }
      }
    }

    for (const [name, target] of symlinks) {
      const prevTarget = prevSymlinks.get(name);
      const symlinkPath = ppath.join(binDir, name);
      // Skip unchanged .bin symlinks
      if (prevTarget === target)
        continue;

      if (process.platform === `win32`) {
        await cmdShim(npath.fromPortablePath(target), npath.fromPortablePath(symlinkPath), {createPwshFile: false});
      } else {
        await xfs.removePromise(symlinkPath);
        await symlinkPromise(target, symlinkPath);
        await xfs.chmodPromise(target, 0o755);
      }
    }
  }
}
