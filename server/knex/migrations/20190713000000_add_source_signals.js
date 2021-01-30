const {SignalSource, SignalType} = require('../../../shared/signals');

exports.up = (knex, Promise) => (async () => {
    await knex.schema.table('signals', table => {
        table.string('source').notNullable().defaultTo(SignalSource.RAW);
    });

    await knex.table('signals').whereIn('type', ['derived_painless_date','derived_painless']).update({source: SignalSource.DERIVED});

    await knex.table('signals').where('type', 'derived_painless_date').update({type: SignalType.DATE_TIME});
    await knex.table('signals').where('type', 'derived_painless').update({type: SignalType.DOUBLE});

    await knex.table('signals').where('type', 'raw_integer').update({type: SignalType.INTEGER});
    await knex.table('signals').where('type', 'raw_long').update({type: SignalType.LONG});
    await knex.table('signals').where('type', 'raw_double').update({type: SignalType.DOUBLE});
    await knex.table('signals').where('type', 'raw_boolean').update({type: SignalType.BOOLEAN});
    await knex.table('signals').where('type', 'raw_keyword').update({type: SignalType.KEYWORD});
    await knex.table('signals').where('type', 'raw_text').update({type: SignalType.TEXT});
    await knex.table('signals').where('type', 'raw_date').update({type: SignalType.DATE_TIME});
})();

exports.down = (knex, Promise) => (async () => {
})();
