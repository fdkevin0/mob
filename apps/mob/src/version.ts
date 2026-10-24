// version is set at build time; a run from source is dev.
export const version: string = process.env.MOB_BUILD_VERSION ?? 'dev';
