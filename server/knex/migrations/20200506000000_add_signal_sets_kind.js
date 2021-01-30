exports.up = (knex, Promise) => (async () => {
    await knex.schema.table('signal_sets', table => {
        table.string('kind').notNullable().defaultTo('generic');
    });
})();

exports.down = (knex, Promise) => (async () => {
});