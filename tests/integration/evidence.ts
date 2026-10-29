/** Test output names only; never used by production routes or archive contents. */
export function testEvidencePrefix(defaultPrefix:string):string {
    const prefix=process.env.SITE_FACTORY_TEST_EVIDENCE_PREFIX??defaultPrefix;
    if(!/^[a-zA-Z0-9-]{1,80}$/.test(prefix))throw new Error('Invalid test evidence prefix');
    return prefix;
}
