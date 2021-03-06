'use strict';

var mysql = require('mysql');

// Connection to the SQL database
var connection;

// Table structure of the SQL database.
var tables = {
  'vars': [
    'block_height_checked INT NOT NULL'
  ],
  'scriptPubKeys': [
    'scriptPubKey_hash BINARY(32) NOT NULL',
    'txid BINARY(32) NOT NULL',
    'INDEX `scriptPubKey_hash` (`scriptPubKey_hash`)',
    'UNIQUE KEY `script_txid` (`scriptPubKey_hash`, `txid`)'
  ]
};

// Current height to which the SQL database is synchronized.
var heightChecked = -1;

// Current height to which the RPC bitcoin daemon is synchronized
var chainHeight = 0;

// An array of recent block hashes, used in detecting and handling block chain forks
var previousBlockHashes = [];

// An array of unconfirmed transactions (txids) that have already been indexed
var unconfirmedTransactions = [];

// This opens the connection to the SQL database and creates the database/table structure if it's
// not already present.
function connectToDatabase(){
  connection = mysql.createConnection(config.mysql);
  connection.connect(handleDatabaseConnection);
  connection.on('error', handleDatabaseError);
}

// On connection to the database, logs a success/failure message to the console and begins creating the
// database structure.
function handleDatabaseConnection(err){
  console.log(err ? 'Failed to connect to MySQL database.' : 'Connected to MySQL database.');
  if (!err){
    createDatabase();
  }
}

// Creates the mychain database and its table structure if not already set up. Begins updating the
// database once it is ready.
function createDatabase(){
  connection.query('CREATE DATABASE IF NOT EXISTS mychain', function (err, result){
    connection.query('USE mychain', function (err, result){
      var remaining = 0;
      for (var table in tables){
        remaining ++;
      }
      for (var table in tables){
        connection.query('CREATE TABLE IF NOT EXISTS '+table+' ('+tables[table].join(',')+')', function(){
          remaining --;
          if (remaining == 0){
            update();
          }
        });
      }
    });
  });
}

// Handle a database error. If connection is lost, attempt to salvage the situation by reconnecting.
function handleDatabaseError(err){
  if (err.code === 'PROTOCOL_CONNECTION_LOST'){
    console.log("Database error. Reconnecting.");
    connectToDatabase();
  }
  else{
    throw err;
  }
}

// This accepts an array of transaction id's, gets their raw transaction data from the RPC, and
// stores it in the outputs table of the SQL database.
function addTransactions(txs, callback){
  if (txs.length > 0){
    rpc.getRawTransaction(txs[0], 1, function(err, ret){
      if (err){
        setTimeout(function(){
          addTransactions(txs, callback);
        }, 1000);
        return;
      }
      addTransaction(ret.result, function(){
        setTimeout(function(){
          txs.shift();
          addTransactions(txs, callback);
        }, 1);
      });
    });
    return;
  }
  callback();
}

// Update 'block_height_checked' in vars table.
function blockAdded(callback){
  heightChecked ++;
  var query = 'UPDATE vars SET block_height_checked='+heightChecked;
  connection.query(query, function(err, result){
    if (err){
      console.log('Database error: Failed to update block_height_checked.');
    }
    callback();
  });
}

// Adds a single transaction's data to the outputs database.
function addTransaction(tx, callback){
  addOutputs(tx, function(){
    callback();
  });
}

// Adds a transaction's outputs to the database.
function addOutputs(tx, callback){
  var outputsInserted = 0;
  for (var output in tx.vout){
    var scriptPubKeyHash = crypto.createHash('sha256').update(tx.vout[output].scriptPubKey.hex).digest('hex');
    var query = 'INSERT INTO scriptPubKeys (scriptPubKey_hash, txid) VALUES (X\''+scriptPubKeyHash+'\', X\''+tx.txid+'\')';
    connection.query(query, function(err, result){
      outputsInserted ++;
      if (outputsInserted == tx.vout.length){
        callback();
      }
    });
  }
}

// This function is run to acquire data about the next block and insert it into the outputs
// table of the SQL database.
function update(){
  if (heightChecked < 0){
    loadHeightChecked(function(){
      update();
    });
    return;
  }
  if (heightChecked >= chainHeight){
    checkForFork(function(){
      rpc.getBlockCount(function(err, ret){
        if (chainHeight == ret.result){
          setTimeout(function(){
            processUnconfirmedTransactions(function(){
              setTimeout(update, 100);
            }, 1);
          }, 10);
          return;
        }
        chainHeight = ret.result;
        setTimeout(update, 10);
      });
    });
    return;
  }
  processNextBlock(function(){
    blockAdded(function(){
      setTimeout(update, 5);
    });
  });
}

// Look to see if a fork has developed in the block chain. If one exists, roll back our progress
// back to the source of the fork.
function checkForFork(callback){
  if (previousBlockHashes.length == 0){
    return callback();
  }
  rpc.getBlockHash((heightChecked), function(err, ret){
    if (previousBlockHashes[previousBlockHashes.length - 1] == ret.result){
      return callback();
    }
    console.log('Fork detected while Checking block height '+(heightChecked+1));
    console.log('Expected hash: '+previousBlockHashes[previousBlockHashes.length - 1]);
    console.log('Found block hash: '+ret.result);
    console.log('Rolling back progress by one block.');
    previousBlockHashes.pop();
    heightChecked --;
    var query = 'UPDATE vars SET block_height_checked='+heightChecked;
    connection.query(query, function(err, result){
      if (err){
        console.log('Database error: Failed to update block_height_checked.');
      }
      checkForFork(callback);
    });
  });
}

// Loads all unconfirmed transactions and indexes any new ones
function processUnconfirmedTransactions(callback){
  rpc.getRawMemPool(function(err, ret){
    var mempool = ret.result;
    var newtx = [];
    for (var txid in mempool){
      if (unconfirmedTransactions.indexOf(mempool[txid]) == -1){
        newtx.push(mempool[txid]);
      }
    }
    unconfirmedTransactions = mempool;
    setTimeout(function(){
      addTransactions(newtx, callback);
    }, 100);
    return;
  });
  return;
}

// Loads the next block and stores its data in the database.
function processNextBlock(callback){
  rpc.getBlockHash((heightChecked+1), function(err, ret){
    if (err){
      return setTimeout(update, 1000);
    }
    var blockhash = ret.result;
    previousBlockHashes.push(blockhash);
    if (previousBlockHashes.length > 120){
      previousBlockHashes.shift();
    }
    rpc.getBlock(blockhash, function(err, ret){
      if (err){
        return setTimeout(update, 1000);
      }
      console.log('Adding transactions from block height '+(heightChecked+1));
      addTransactions(ret.result.tx, callback);
    });
  });
}

// Loads the height checked from database.
function loadHeightChecked(callback){
  connection.query('SELECT block_height_checked FROM vars', function(err, rows){
    if (rows.length == 0){
      var query = 'INSERT INTO vars (block_height_checked) VALUES (0)';
      connection.query(query, function(err, result){
        heightChecked = 0;
        callback();
      });
    }
    else if (rows.length == 1){
      heightChecked = rows[0]['block_height_checked'];
      callback();
    }
    else{
      console.log('There is a problem with the database \'vars\' table. Multiple rows exist, and there should be only one.');
    }
  });
}

// Process a SELECT query.
exports.get = function(query, callback){
  connection.query(query, function(err, rows){
    if (err){
      console.log('Database error for query: '+query);
      return;
    }
    callback(rows);
  });
}

// Get the height checked so far
exports.getHeightChecked = function(){
  return heightChecked;
}

// Get the block chain height
exports.getChainHeight = function(){
  return chainHeight;
}

// Begin the connection.
connectToDatabase();
