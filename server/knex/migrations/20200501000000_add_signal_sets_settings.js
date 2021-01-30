exports.up = (knex, Promise) => (async () => {
    const sigSets = await knex.table('signal_sets');
    for (const sigSet of sigSets) {
        sigSet.indexing = JSON.stringify({indexing: JSON.parse(sigSet.indexing)});
        await knex('signal_sets').where('id', sigSet.id).update(sigSet);
    }

    await knex.schema.table('signal_sets', table => {
        table.renameColumn('indexing', 'state');
        table.text('settings', 'longtext').notNullable();
    });

    // text can't have default value in MYSQL for some reason
    await knex('signal_sets').update('settings', JSON.stringify({}));
})();

exports.down = (knex, Promise) => (async () => {
});