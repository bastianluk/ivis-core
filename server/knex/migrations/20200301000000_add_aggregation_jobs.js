
exports.up = (knex, Promise) => (async () => {
    await knex.raw('SET FOREIGN_KEY_CHECKS=0');
    await knex.schema.createTable('aggregation_jobs', table => {
        table.integer('set').unsigned().notNullable().references('signal_sets.id').onDelete('CASCADE');
        table.integer('job').unsigned().notNullable().references('jobs.id').onDelete('CASCADE');
        table.bigInteger('interval').unsigned().notNullable();
        table.unique(['set','job']);
    });
    await knex.raw('SET FOREIGN_KEY_CHECKS=1');
})();

exports.down = (knex, Promise) => (async () => {
});
