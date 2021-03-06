'use strict';

// Render a block page for a given blockhash.
exports.render = function (req, res) {
  var blockhash = req.params.blockhash;
  rpc.getBlock(blockhash, function(err, ret){
    if (err){
      res.render('index', {error: 'Block was invalid: '+blockhash});
      return;
    }
    var block = ret.result;
    res.render('block', {block: block});
  });
};
