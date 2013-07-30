#!/usr/bin/env node

var DEBUG;

var dgram = require('dgram');
var net   = require("net");

var id_mapper = {};

(function main() {

    try {
        var opts = require('opts');
    } catch (e) {
        console.error(e);
        return -1;
    }

    opts.parse([
        {
            'short'      : 'v',
            'long'       : 'version',
            'description': 'show version of dnsmux.js',
            'value'      : false,
            'required'   : false,
            'callback'   : opt_version
        },
        {
            'short'      : 's',
            'long'       : 'server',
            'description': 'dns server ip (default: 8.8.8.8)',
            'value'      : true,
            'required'   : false,
            'callback'   : undefined
        },
        {
            'short'      : 'p',
            'long'       : 'port',
            'description': 'dns server port (default: 53)',
            'value'      : true,
            'required'   : false,
            'callback'   : undefined
        },
        {
            'short'      : 'l',
            'long'       : 'local',
            'description': 'proxy service port (default: 53)',
            'value'      : true,
            'required'   : false,
            'callback'   : undefined
        },
        {
            'short'      : 'd',
            'long'       : 'debug',
            'description': 'show debug messages',
            'value'      : false,
            'required'   : false,
            'callback'   : undefined
        },
        {
            'short'      : 'h',
            'long'       : 'help',
            'description': 'show help command',
            'value'      : false,
            'required'   : false,
            'callback'   : opt_help
        }
    ]);

    function opt_version() {
        console.log('version 0.0.1');
        process.exit(0);
    };

    function opt_help() {
        console.log(opts.help());
        process.exit(0);
    };

    var DEBUG = opts.get('debug');

    var odd_data = Buffer(0);

    var TCP_OPT = {};
    TCP_OPT.host = opts.get('server')
    if (TCP_OPT.host == undefined) {
        TCP_OPT.host= '8.8.8.8';
    }
    TCP_OPT.port = opts.get('port');
    if (TCP_OPT.port == undefined) {
        TCP_OPT.port = 53;
    }

    var UDP_HOST = 'localhost';
    var UDP_PORT = opts.get('local');
    if (UDP_PORT == undefined) {
         UDP_PORT = 53;
    }

    var tcp_status = 'END';
    var tcp_client = new net.Socket({type: 'tcp4'});
    tcp_client.connect(TCP_OPT.port, TCP_OPT.host);
    tcp_client.setNoDelay(true);
    tcp_client.setKeepAlive(true, 1000);
     
    var udp_wait_buffer = [];
    var udp4_server = dgram.createSocket('udp4');
    var udp6_server = dgram.createSocket('udp6');
     
    tcp_client.on('error', function(e) {
        if (e['code'] == 'Unknown system errno 37') {
            ;
        } else {
            console.error(e['errno']);
            process.exit();
        }
    });

    tcp_client.on('connect', function(){
        tcp_status = 'EST';
        while (udp_wait_buffer.length != 0) {
            var wait_msg = udp_wait_buffer.shift();
            udp_handler(tcp_client, wait_msg[0], wait_msg[1]);
        }
        if (DEBUG) {
            console.log('connection EST - ' + TCP_OPT.host + ':' + TCP_OPT.port);
        }
    });

    tcp_client.on('end', function(had_error){
        tcp_status = 'END';
        if (DEBUG) {
            console.log('connection END - ' + TCP_OPT.host + ':' + TCP_OPT.port);
        }
    });

    tcp_client.on('close', function(){
        tcp_status = 'END';
    });

    tcp_client.on('data', function(data){
        var byte_stream = new Buffer(data);
        odd_data = tcp_handler(udp4_server, udp6_server, odd_data, byte_stream);
    });

    udp4_server.on("listening", function () {
        if (DEBUG) {
            var address = udp4_server.address();
            console.log('udp4 listening - ' + address.address + ':' + address.port);
        }
    });

    udp4_server.on("close", function () { 
        process.exit();
    });

    udp4_server.on("message", function (msg, rinfo) {
        if (tcp_status == 'EST') {
            udp_handler(tcp_client, msg, rinfo);
        } else {
            udp_wait_buffer.push([msg, rinfo]);
            if (tcp_status == 'END') {
                tcp_status = 'CONN';
                tcp_client.connect(TCP_OPT.port, TCP_OPT.host);
            }
        }
        //console.log(tcp_status);
    });

    udp4_server.on('error', function(e) {
        console.error(e);
        process.exit();
    });

    udp6_server.on("listening", function () {
        if (DEBUG) {
            var address = udp6_server.address();
            console.log('udp6 listening - ' + address.address + ':' + address.port);
        }
    });

    udp6_server.on("close", function () { 
        process.exit();
    });

    udp6_server.on("message", function (msg, rinfo) {
        if (tcp_status == 'EST') {
            udp_handler(tcp_client, msg, rinfo);
        } else {
            udp_wait_buffer.push([msg, rinfo]);
            if (tcp_status == 'END') {
                tcp_status = 'CONN';
                tcp_client.connect(TCP_OPT.port, TCP_OPT.host);
            }
        }
        //console.log(tcp_status);
    });

    udp6_server.on('error', function(e) {
        console.error(e);
        process.exit();
    });

    udp4_server.bind(UDP_PORT, UDP_HOST);
    udp6_server.bind(UDP_PORT, UDP_HOST);

}).call(this);

function udp_handler(forward, msg, rinfo) {

    if (DEBUG) {
        console.log("receive " + msg.length + "bytes" + 
                    ", from " + rinfo.address + ":" + rinfo.port + 
                    ", DNS-ID " + msg.readUInt16BE(0));
    }

    var payload_length = new Buffer(2);
    payload_length.writeUInt16BE(msg.length, 0);

    id_mapper[msg.readUInt16BE(0)] = {
        'from_addr': rinfo.address,
        'from_port': rinfo.port,
        'dns_id'   : msg.readUInt16BE(0),
    }

    forward.write(Buffer.concat([payload_length, msg]));
}

function tcp_handler(forward4, forward6, odd_data, byte_stream) {

    byte_stream = Buffer.concat([odd_data, byte_stream]);

    while(true) {
        if (byte_stream == 0) {
            //console.log('commonly return');
            return new Buffer(0);
        } else if (byte_stream <= 2) {
            //console.log('odd return (no payload size)');
            return byte_stream;
        } else {
            var msg_size = byte_stream.readUInt16BE(0);
        }

        if (byte_stream.length >= msg_size) {
            var msg = byte_stream.slice(2, msg_size+2);
            byte_stream = byte_stream.slice(msg_size+2);
        } else {
            //console.log('odd return');
            return byte_stream;
        }

        var peer_info = id_mapper[msg.readUInt16BE(0)];
        var peer_addr = peer_info['from_addr'];
        var peer_port = peer_info['from_port'];
        var peer_id   = peer_info['from_id'];

        if (net.isIPv4(peer_addr)) {
            forward4.send(msg, 0, msg_size, peer_port, peer_addr);
        } else if (net.isIPv6(peer_addr)) {
            forward6.send(msg, 0, msg_size, peer_port, peer_addr);
        } else {
            ;
        }
    }
}