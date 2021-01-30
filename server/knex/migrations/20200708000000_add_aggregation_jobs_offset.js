exports.up = (knex, Promise) => (async () => {

    await knex.schema.table('aggregation_jobs', table => {
        table.dateTime('offset');
    });

})();

exports.down = (knex, Promise) => (async () => {
});