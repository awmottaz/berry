import {Plugin, SettingsType} from '@yarnpkg/core';
import {PortablePath}         from '@yarnpkg/fslib';

import versionApply           from './commands/version/apply';
import versionCheck           from './commands/version/check';
import version                from './commands/version';

declare module '@yarnpkg/core' {
  interface ConfigurationValueMap {
    changesetBaseRefs: Array<string>;
    changesetIgnorePatterns: Array<string>;
    deferredVersionFolder: PortablePath;
    changelogsFolder: PortablePath;
    preferDeferredVersions: boolean;
    preferChangelogs: boolean;
  }
}

const plugin: Plugin = {
  configuration: {
    changesetBaseRefs: {
      description: `The base git refs that the current HEAD is compared against when detecting changes. Supports git branches, tags, and commits.`,
      type: SettingsType.STRING,
      isArray: true,
      isNullable: false,
      default: [`master`, `origin/master`, `upstream/master`],
    },
    changesetIgnorePatterns: {
      description: `Array of glob patterns; files matching them will be ignored when fetching the changed files`,
      type: SettingsType.STRING,
      default: [],
      isArray: true,
    },
    deferredVersionFolder: {
      description: `Folder where the versioning files are stored`,
      type: SettingsType.ABSOLUTE_PATH,
      default: `./.yarn/versions`,
    },
    changelogsFolder: {
      description: `Folder where the changelog files are stored`,
      type: SettingsType.ABSOLUTE_PATH,
      default: `./.yarn/versions/changelogs`,
    },
    preferDeferredVersions: {
      description: `If true, running \`yarn version\` will assume the \`--deferred\` flag unless \`--immediate\` is set`,
      type: SettingsType.BOOLEAN,
      default: false,
    },
    preferChangelogs: {
      description: `If true, running \`yarn version\` will assume the \`--changelog\` flag`,
      type: SettingsType.BOOLEAN,
      default: false,
    },
  },
  commands: [
    versionApply,
    versionCheck,
    version,
  ],
};

// eslint-disable-next-line arca/no-default-export
export default plugin;
