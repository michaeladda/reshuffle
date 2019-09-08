import { join, dirname, basename, extname } from 'path';
import { homedir } from 'os';
import memoize from 'lodash.memoize';
import Conf from 'conf';
import { safeDump, safeLoad } from 'js-yaml';

export const defaultLocation = join(homedir(), '.shiftjs', 'shiftjs.config.yml');

export function deconstruct(path: string) {
  const fileExtension = extname(path);
  return {
    fileExtension: fileExtension.replace(/^\./, ''),
    configName: basename(path, fileExtension),
    cwd: dirname(path),
  };
}

export const load = memoize((path: string) => {
  const { fileExtension, configName, cwd } = deconstruct(path);

  return new Conf({
    cwd,
    configName,
    fileExtension,
    serialize: safeDump,
    deserialize: safeLoad,
    clearInvalidConfig: false,
  });
});
