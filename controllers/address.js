'use strict';

// Render an address page for a given address.
exports.render = function (req, res) {
  var addr = req.params.address;
  if (!(new Address(addr)).isValid()){
    res.render('index', {error: 'Address was invalid: '+addr});
    return;
  }
  AddressTools.getAddressData(addr, function(address){
    var response = {};
    res.render('address', {address: address});
  });
};
