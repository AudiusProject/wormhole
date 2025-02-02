const jsonfile = require('jsonfile');
const elliptic = require('elliptic');
const BigNumber = require('bignumber.js');

const Wormhole = artifacts.require("Wormhole");
const TokenBridge = artifacts.require("TokenBridge");
const BridgeImplementation = artifacts.require("BridgeImplementation");
const TokenImplementation = artifacts.require("TokenImplementation");
const MockBridgeImplementation = artifacts.require("MockBridgeImplementation");
const MockWETH9 = artifacts.require("MockWETH9");

const testSigner1PK = "cfb12303a19cde580bb4dd771639b0d26bc68353645571a8cff516ab2ee113a0";
const testSigner2PK = "892330666a850761e7370376430bb8c2aa1494072d3bfeaed0c4fa3d5a9135fe";

const WormholeImplementationFullABI = jsonfile.readFileSync("build/contracts/Implementation.json").abi
const BridgeImplementationFullABI = jsonfile.readFileSync("build/contracts/BridgeImplementation.json").abi
const TokenImplementationFullABI = jsonfile.readFileSync("build/contracts/TokenImplementation.json").abi

contract("Bridge", function () {
    const testSigner1 = web3.eth.accounts.privateKeyToAccount(testSigner1PK);
    const testSigner2 = web3.eth.accounts.privateKeyToAccount(testSigner2PK);
    const testChainId = "2";
    const testGovernanceChainId = "3";
    const testGovernanceContract = "0x0000000000000000000000000000000000000000000000000000000000000004";
    let WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
    const testForeignChainId = "1";
    const testForeignBridgeContract = "0x000000000000000000000000000000000000000000000000000000000000ffff";
    const testBridgedAssetChain = "0001";
    const testBridgedAssetAddress = "000000000000000000000000b7a2211e8165943192ad04f5dd21bedc29ff003e";


    it("should be initialized with the correct signers and values", async function(){
        const initialized = new web3.eth.Contract(BridgeImplementationFullABI, TokenBridge.address);

        const weth = await initialized.methods.WETH().call();
        assert.equal(weth, WETH);

        const tokenImplentation = await initialized.methods.tokenImplementation().call();
        assert.equal(tokenImplentation, TokenImplementation.address);

        // test beacon functionality
        const beaconImplementation = await initialized.methods.implementation().call();
        assert.equal(beaconImplementation, TokenImplementation.address);

        // chain id
        const chainId = await initialized.methods.chainId().call();
        assert.equal(chainId, testChainId);

        // governance
        const governanceChainId = await initialized.methods.governanceChainId().call();
        assert.equal(governanceChainId, testGovernanceChainId);
        const governanceContract = await initialized.methods.governanceContract().call();
        assert.equal(governanceContract, testGovernanceContract);
    })

    it("initialize should be non-reentrant", async function(){
        const initialized = new web3.eth.Contract(BridgeImplementationFullABI, TokenBridge.address);

        try{
            await initialized.methods.initialize(
                1,
                Wormhole.address,
                1,
                testGovernanceContract,
                TokenImplementation.address,
                WETH
            ).estimateGas();
        }  catch (error) {
            assert.equal(error.message, "Returned error: VM Exception while processing transaction: revert already initialized")
            return
        }

        assert.fail("did not fail")
    })


    it("should register a foreign bridge implementation correctly", async function() {
        const initialized = new web3.eth.Contract(BridgeImplementationFullABI, TokenBridge.address);
        const accounts = await web3.eth.getAccounts();

        let data = [
            "0x",
            "000000000000000000000000000000000000000000546f6b656e427269646765",
            "01",
            "0000",
            web3.eth.abi.encodeParameter("uint16", testForeignChainId).substring(2 + (64 - 4)),
            web3.eth.abi.encodeParameter("bytes32", testForeignBridgeContract).substring(2),
        ].join('')

        const vm = await signAndEncodeVM(
            1,
            1,
            testGovernanceChainId,
            testGovernanceContract,
            0,
            data,
            [
                testSigner1PK
            ],
            0,
            0
        );


        let before = await initialized.methods.bridgeContracts(testForeignChainId).call();

        assert.equal(before, "0x0000000000000000000000000000000000000000000000000000000000000000");

        await initialized.methods.registerChain("0x" + vm).send({
            value : 0,
            from : accounts[0],
            gasLimit : 2000000
        });

        let after = await initialized.methods.bridgeContracts(testForeignChainId).call();

        assert.equal(after, testForeignBridgeContract);
    })

    it("should accept a valid upgrade", async function() {
        const initialized = new web3.eth.Contract(BridgeImplementationFullABI, TokenBridge.address);
        const accounts = await web3.eth.getAccounts();

        const mock = await MockBridgeImplementation.new();

        let data = [
            "0x",
            "000000000000000000000000000000000000000000546f6b656e427269646765",
            "02",
            web3.eth.abi.encodeParameter("uint16", testChainId).substring(2 + (64 - 4)),
            web3.eth.abi.encodeParameter("address", mock.address).substring(2),
        ].join('')

        const vm = await signAndEncodeVM(
            1,
            1,
            testGovernanceChainId,
            testGovernanceContract,
            0,
            data,
            [
                testSigner1PK
            ],
            0,
            0
        );

        let before = await web3.eth.getStorageAt(TokenBridge.address, "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc");

        assert.equal(before.toLowerCase(), BridgeImplementation.address.toLowerCase());

        await initialized.methods.upgrade("0x" + vm).send({
            value : 0,
            from : accounts[0],
            gasLimit : 2000000
        });

        let after = await web3.eth.getStorageAt(TokenBridge.address, "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc");

        assert.equal(after.toLowerCase(), mock.address.toLowerCase());

        const mockImpl = new web3.eth.Contract(MockBridgeImplementation.abi, TokenBridge.address);

        let isUpgraded = await mockImpl.methods.testNewImplementationActive().call();

        assert.ok(isUpgraded);
    })

    it("bridged tokens should only be mint- and burn-able by owner", async function() {
        const accounts = await web3.eth.getAccounts();

        // initialize our template token contract
        const token = new web3.eth.Contract(TokenImplementation.abi, TokenImplementation.address);

        await token.methods.initialize(
            "TestToken",
            "TT",
            18,

            accounts[0],

            0,
            "0x0"
        ).send({
            value : 0,
            from : accounts[0],
            gasLimit : 2000000
        });

        await token.methods.mint(accounts[0], 10).send({
            from : accounts[0],
            gasLimit : 2000000
        });

        await token.methods.burn(accounts[0], 5).send({
            from : accounts[0],
            gasLimit : 2000000
        });

        let failed = false
        try {
            await token.methods.mint(accounts[0], 10).send({
                from : accounts[1],
                gasLimit : 2000000
            });
        } catch(e) {
            failed = true
        }
        assert.ok(failed)

        failed = false
        try {
            await token.methods.burn(accounts[0], 5).send({
                from : accounts[1],
                gasLimit : 2000000
            });
        } catch(e) {
            failed = true
        }
        assert.ok(failed)

        await token.methods.burn(accounts[0], 5).send({
            from : accounts[0],
            gasLimit : 2000000
        });
    })

    it("should attest a token correctly", async function() {
        const accounts = await web3.eth.getAccounts();

        const initialized = new web3.eth.Contract(BridgeImplementationFullABI, TokenBridge.address);

        await initialized.methods.attestToken(TokenImplementation.address, "234").send({
            value : 0,
            from : accounts[0],
            gasLimit : 2000000
        });

        const wormhole = new web3.eth.Contract(WormholeImplementationFullABI, Wormhole.address);

        const log = (await wormhole.getPastEvents('LogMessagePublished', {
            fromBlock : 'latest'
        }))[0].returnValues

        assert.equal(log.sender, TokenBridge.address)

        assert.equal(log.payload.length - 2, 200);

        // payload id
        assert.equal(log.payload.substr(2, 2), "02");

        // token address
        assert.equal(log.payload.substr(4, 64), web3.eth.abi.encodeParameter("address", TokenImplementation.address).substring(2));

        // chain id
        assert.equal(log.payload.substr(68, 4), web3.eth.abi.encodeParameter("uint16", testChainId).substring(2 + 64 - 4))

        // decimals
        assert.equal(log.payload.substr(72, 2), web3.eth.abi.encodeParameter("uint8", 18).substring(2 + 64 - 2))

        // symbol (TT)
        assert.equal(log.payload.substr(74, 64), "5454000000000000000000000000000000000000000000000000000000000000")

        // name (TestToken)
        assert.equal(log.payload.substr(138, 64), "54657374546f6b656e0000000000000000000000000000000000000000000000")
    })

    it("should correctly deploy a wrapped asset for a token attestation", async function() {
        const initialized = new web3.eth.Contract(BridgeImplementationFullABI, TokenBridge.address);
        const accounts = await web3.eth.getAccounts();

        const data = "0x02" +
            // tokenAddress
            testBridgedAssetAddress +
            // tokenchain
            testBridgedAssetChain +
            // decimals
            "12" +
            // symbol
            "5454000000000000000000000000000000000000000000000000000000000000" +
            // name
            "54657374546f6b656e0000000000000000000000000000000000000000000000";

        const vm = await signAndEncodeVM(
            0,
            0,
            testForeignChainId,
            testForeignBridgeContract,
            0,
            data,
            [
                testSigner1PK
            ],
            0,
            0
        );

        await initialized.methods.createWrapped("0x" + vm).send({
            value : 0,
            from : accounts[0],
            gasLimit : 2000000
        });

        const wrappedAddress = await initialized.methods.wrappedAsset("0x0001", "0x000000000000000000000000b7a2211e8165943192ad04f5dd21bedc29ff003e").call();

        assert.ok(await initialized.methods.isWrappedAsset(wrappedAddress).call())

        const initializedWrappedAsset = new web3.eth.Contract(TokenImplementation.abi, wrappedAddress);

        const symbol = await initializedWrappedAsset.methods.symbol().call();
        assert.equal(symbol, "TT");

        const name = await initializedWrappedAsset.methods.name().call();
        assert.equal(name, "TestToken");

        const decimals = await initializedWrappedAsset.methods.decimals().call();
        assert.equal(decimals, 18);

        const chainId = await initializedWrappedAsset.methods.chainId().call();
        assert.equal(chainId, 1);

        const nativeContract = await initializedWrappedAsset.methods.nativeContract().call();
        assert.equal(nativeContract, "0x000000000000000000000000b7a2211e8165943192ad04f5dd21bedc29ff003e");
    })

    it("should deposit and log transfers correctly", async function() {
        const accounts = await web3.eth.getAccounts();
        const amount = "1000000000000000000";
        const fee = "100000000000000000";

        // mint and approve tokens
        const token = new web3.eth.Contract(TokenImplementation.abi, TokenImplementation.address);
        await token.methods.mint(accounts[0], amount).send({
            value : 0,
            from : accounts[0],
            gasLimit : 2000000
        });
        await token.methods.approve(TokenBridge.address, amount).send({
            value : 0,
            from : accounts[0],
            gasLimit : 2000000
        });

        // deposit tokens
        const initialized = new web3.eth.Contract(BridgeImplementationFullABI, TokenBridge.address);

        const accountBalanceBefore = await token.methods.balanceOf(accounts[0]).call();
        const bridgeBalanceBefore = await token.methods.balanceOf(TokenBridge.address).call();

        assert.equal(accountBalanceBefore.toString(10), amount);
        assert.equal(bridgeBalanceBefore.toString(10), "0");

        await initialized.methods.transferTokens(
            TokenImplementation.address,
            amount,
            "10",
            "0x000000000000000000000000b7a2211e8165943192ad04f5dd21bedc29ff003e",
            fee,
            "234"
        ).send({
            value : 0,
            from : accounts[0],
            gasLimit : 2000000
        });

        const accountBalanceAfter = await token.methods.balanceOf(accounts[0]).call();
        const bridgeBalanceAfter = await token.methods.balanceOf(TokenBridge.address).call();

        assert.equal(accountBalanceAfter.toString(10), "0");
        assert.equal(bridgeBalanceAfter.toString(10), amount);

        // check transfer log
        const wormhole = new web3.eth.Contract(WormholeImplementationFullABI, Wormhole.address);
        const log = (await wormhole.getPastEvents('LogMessagePublished', {
            fromBlock : 'latest'
        }))[0].returnValues

        assert.equal(log.sender, TokenBridge.address)

        assert.equal(log.payload.length - 2, 266);

        // payload id
        assert.equal(log.payload.substr(2, 2), "01");

        // amount
        assert.equal(log.payload.substr(4, 64), web3.eth.abi.encodeParameter("uint256", new BigNumber(amount).div(1e10).toString()).substring(2));

        // token
        assert.equal(log.payload.substr(68, 64), web3.eth.abi.encodeParameter("address", TokenImplementation.address).substring(2));

        // chain id
        assert.equal(log.payload.substr(132, 4), web3.eth.abi.encodeParameter("uint16", testChainId).substring(2 + 64 - 4))

        // to
        assert.equal(log.payload.substr(136, 64), "000000000000000000000000b7a2211e8165943192ad04f5dd21bedc29ff003e");

        // to chain id
        assert.equal(log.payload.substr(200, 4), web3.eth.abi.encodeParameter("uint16", 10).substring(2 + 64 - 4))

        // fee
        assert.equal(log.payload.substr(204, 64), web3.eth.abi.encodeParameter("uint256", new BigNumber(fee).div(1e10).toString()).substring(2))
    })

    it("should transfer out locked assets for a valid transfer vm", async function() {
        const accounts = await web3.eth.getAccounts();
        const amount = "1000000000000000000";

        const token = new web3.eth.Contract(TokenImplementation.abi, TokenImplementation.address);
        const initialized = new web3.eth.Contract(BridgeImplementationFullABI, TokenBridge.address);


        const accountBalanceBefore = await token.methods.balanceOf(accounts[0]).call();
        const bridgeBalanceBefore = await token.methods.balanceOf(TokenBridge.address).call();

        assert.equal(accountBalanceBefore.toString(10), "0");
        assert.equal(bridgeBalanceBefore.toString(10), amount);

        const data = "0x" +
            "01" +
            // amount
            web3.eth.abi.encodeParameter("uint256", new BigNumber(amount).div(1e10).toString()).substring(2) +
            // tokenaddress
            web3.eth.abi.encodeParameter("address", TokenImplementation.address).substr(2) +
            // tokenchain
            web3.eth.abi.encodeParameter("uint16", testChainId).substring(2 + (64 - 4)) +
            // receiver
            web3.eth.abi.encodeParameter("address", accounts[0]).substr(2) +
            // receiving chain
            web3.eth.abi.encodeParameter("uint16", testChainId).substring(2 + (64 - 4)) +
            // fee
            "0000000000000000000000000000000000000000000000000000000000000000";

        const vm = await signAndEncodeVM(
            0,
            0,
            testForeignChainId,
            testForeignBridgeContract,
            0,
            data,
            [
                testSigner1PK
            ],
            0,
            0
        );

        await initialized.methods.completeTransfer("0x" + vm).send({
            value : 0,
            from : accounts[0],
            gasLimit : 2000000
        });

        const accountBalanceAfter = await token.methods.balanceOf(accounts[0]).call();
        const bridgeBalanceAfter = await token.methods.balanceOf(TokenBridge.address).call();

        assert.equal(accountBalanceAfter.toString(10), amount);
        assert.equal(bridgeBalanceAfter.toString(10), "0");
    })

    it("should mint bridged assets wrappers on transfer from another chain", async function() {
        const accounts = await web3.eth.getAccounts();
        const amount = "1000000000000000000";

        const initialized = new web3.eth.Contract(BridgeImplementationFullABI, TokenBridge.address);

        const wrappedAddress = await initialized.methods.wrappedAsset("0x"+testBridgedAssetChain, "0x"+testBridgedAssetAddress).call();
        const wrappedAsset = new web3.eth.Contract(TokenImplementation.abi, wrappedAddress);

        const totalSupply = await wrappedAsset.methods.totalSupply().call();
        assert.equal(totalSupply.toString(10), "0");

        // we are using the asset where we created a wrapper in the previous test
        const data = "0x" +
            "01" +
            // amount
            web3.eth.abi.encodeParameter("uint256", new BigNumber(amount).div(1e10).toString()).substring(2) +
            // tokenaddress
            testBridgedAssetAddress +
            // tokenchain
            testBridgedAssetChain +
            // receiver
            web3.eth.abi.encodeParameter("address", accounts[0]).substr(2) +
            // receiving chain
            web3.eth.abi.encodeParameter("uint16", testChainId).substring(2 + (64 - 4)) +
            // fee
            "0000000000000000000000000000000000000000000000000000000000000000";

        const vm = await signAndEncodeVM(
            0,
            0,
            testForeignChainId,
            testForeignBridgeContract,
            0,
            data,
            [
                testSigner1PK
            ],
            0,
            0
        );

        await initialized.methods.completeTransfer("0x" + vm).send({
            value : 0,
            from : accounts[0],
            gasLimit : 2000000
        });

        const accountBalanceAfter = await wrappedAsset.methods.balanceOf(accounts[0]).call();
        const totalSupplyAfter = await wrappedAsset.methods.totalSupply().call();

        assert.equal(accountBalanceAfter.toString(10), amount);
        assert.equal(totalSupplyAfter.toString(10), amount);
    })

    it("should burn bridged assets wrappers on transfer to another chain", async function() {

        const accounts = await web3.eth.getAccounts();
        const initialized = new web3.eth.Contract(BridgeImplementationFullABI, TokenBridge.address);
        const amount = "1000000000000000000";

        const wrappedAddress = await initialized.methods.wrappedAsset("0x"+testBridgedAssetChain, "0x"+testBridgedAssetAddress).call();
        const wrappedAsset = new web3.eth.Contract(TokenImplementation.abi, wrappedAddress);

        await wrappedAsset.methods.approve(TokenBridge.address, amount).send({
            value : 0,
            from : accounts[0],
            gasLimit : 2000000
        });

        // deposit tokens

        const accountBalanceBefore = await wrappedAsset.methods.balanceOf(accounts[0]).call();

        assert.equal(accountBalanceBefore.toString(10), amount);

        await initialized.methods.transferTokens(
            wrappedAddress,
            amount,
            "11",
            "0x000000000000000000000000b7a2211e8165943192ad04f5dd21bedc29ff003e",
            "0",
            "234"
        ).send({
            value : 0,
            from : accounts[0],
            gasLimit : 2000000
        });

        const accountBalanceAfter = await wrappedAsset.methods.balanceOf(accounts[0]).call();
        assert.equal(accountBalanceAfter.toString(10), "0");

        const bridgeBalanceAfter = await wrappedAsset.methods.balanceOf(TokenBridge.address).call();
        assert.equal(bridgeBalanceAfter.toString(10), "0");

        const totalSupplyAfter = await wrappedAsset.methods.totalSupply().call();
        assert.equal(totalSupplyAfter.toString(10), "0");
    })

    it("should handle ETH deposits correctly", async function() {
        const accounts = await web3.eth.getAccounts();
        const amount = "100000000000000000";
        const fee = "10000000000000000";

        // mint and approve tokens
        WETH = (await MockWETH9.new()).address;
        const token = new web3.eth.Contract(MockWETH9.abi, WETH);

        // set WETH contract
        const mock = new web3.eth.Contract(MockBridgeImplementation.abi, TokenBridge.address);
        mock.methods.testUpdateWETHAddress(WETH).send({
            from : accounts[0],
            gasLimit : 2000000
        });

        // deposit tokens
        const initialized = new web3.eth.Contract(BridgeImplementationFullABI, TokenBridge.address);

        const totalWETHSupply = await token.methods.totalSupply().call();
        const bridgeBalanceBefore = await token.methods.balanceOf(TokenBridge.address).call();

        assert.equal(totalWETHSupply.toString(10), "0");
        assert.equal(bridgeBalanceBefore.toString(10), "0");

        await initialized.methods.wrapAndTransferETH(
            "10",
            "0x000000000000000000000000b7a2211e8165943192ad04f5dd21bedc29ff003e",
            fee,
            "234"
        ).send({
            value : amount,
            from : accounts[0],
            gasLimit : 2000000
        });

        const totalWETHSupplyAfter = await token.methods.totalSupply().call();
        const bridgeBalanceAfter = await token.methods.balanceOf(TokenBridge.address).call();

        assert.equal(totalWETHSupplyAfter.toString(10), amount);
        assert.equal(bridgeBalanceAfter.toString(10), amount);

        // check transfer log
        const wormhole = new web3.eth.Contract(WormholeImplementationFullABI, Wormhole.address);
        const log = (await wormhole.getPastEvents('LogMessagePublished', {
            fromBlock : 'latest'
        }))[0].returnValues

        assert.equal(log.sender, TokenBridge.address)

        assert.equal(log.payload.length - 2, 266);

        // payload id
        assert.equal(log.payload.substr(2, 2), "01");

        // amount
        assert.equal(log.payload.substr(4, 64), web3.eth.abi.encodeParameter("uint256", new BigNumber(amount).div(1e10).toString()).substring(2));

        // token
        assert.equal(log.payload.substr(68, 64), web3.eth.abi.encodeParameter("address", WETH).substring(2));

        // chain id
        assert.equal(log.payload.substr(132, 4), web3.eth.abi.encodeParameter("uint16", testChainId).substring(2 + 64 - 4))

        // to
        assert.equal(log.payload.substr(136, 64), "000000000000000000000000b7a2211e8165943192ad04f5dd21bedc29ff003e");

        // to chain id
        assert.equal(log.payload.substr(200, 4), web3.eth.abi.encodeParameter("uint16", 10).substring(2 + 64 - 4))

        // fee
        assert.equal(log.payload.substr(204, 64), web3.eth.abi.encodeParameter("uint256", new BigNumber(fee).div(1e10).toString()).substring(2))
    })

    it("should handle ETH withdrawals and fees correctly", async function() {
        const accounts = await web3.eth.getAccounts();
        const amount = "100000000000000000";
        const fee = "50000000000000000";

        const initialized = new web3.eth.Contract(BridgeImplementationFullABI, TokenBridge.address);

        const token = new web3.eth.Contract(MockWETH9.abi, WETH);

        const totalSupply = await token.methods.totalSupply().call();
        assert.equal(totalSupply.toString(10), amount);

        const feeRecipientBalanceBefore = await web3.eth.getBalance(accounts[0]);
        const accountBalanceBefore = await web3.eth.getBalance(accounts[1]);

        // we are using the asset where we created a wrapper in the previous test
        const data = "0x" +
            "01" +
            // amount
            web3.eth.abi.encodeParameter("uint256", new BigNumber(amount).div(1e10).toString()).substring(2) +
            // tokenaddress
            web3.eth.abi.encodeParameter("address", WETH).substr(2) +
            // tokenchain
            web3.eth.abi.encodeParameter("uint16", testChainId).substring(2 + (64 - 4)) +
            // receiver
            web3.eth.abi.encodeParameter("address", accounts[1]).substr(2) +
            // receiving chain
            web3.eth.abi.encodeParameter("uint16", testChainId).substring(2 + (64 - 4)) +
            // fee
            web3.eth.abi.encodeParameter("uint256", new BigNumber(fee).div(1e10).toString()).substring(2);

        const vm = await signAndEncodeVM(
            0,
            0,
            testForeignChainId,
            testForeignBridgeContract,
            0,
            data,
            [
                testSigner1PK
            ],
            0,
            0
        );

        const transferTX = await initialized.methods.completeTransferAndUnwrapETH("0x" + vm).send({
            from : accounts[0],
            gasLimit : 2000000
        });

        const totalSupplyAfter = await token.methods.totalSupply().call();
        assert.equal(totalSupplyAfter.toString(10), "0");

        const accountBalanceAfter = await web3.eth.getBalance(accounts[1]);
        const feeRecipientBalanceAfter = await web3.eth.getBalance(accounts[0]);

        assert.equal((new BigNumber(accountBalanceAfter)).minus(accountBalanceBefore).toString(10), (new BigNumber(amount)).minus(fee).toString(10))
        assert.ok((new BigNumber(feeRecipientBalanceAfter)).gt(feeRecipientBalanceBefore))
    })

    it("should revert on transfer out of a total of > max(uint64) tokens", async function() {
        const accounts = await web3.eth.getAccounts();
        const supply = "184467440737095516160000000000";
        const firstTransfer = "1000000000000";

        // mint and approve tokens
        const token = new web3.eth.Contract(TokenImplementation.abi, TokenImplementation.address);
        await token.methods.mint(accounts[0], supply).send({
            value : 0,
            from : accounts[0],
            gasLimit : 2000000
        });
        await token.methods.approve(TokenBridge.address, supply).send({
            value : 0,
            from : accounts[0],
            gasLimit : 2000000
        });

        // deposit tokens
        const initialized = new web3.eth.Contract(BridgeImplementationFullABI, TokenBridge.address);

        await initialized.methods.transferTokens(
            TokenImplementation.address,
            firstTransfer,
            "10",
            "0x000000000000000000000000b7a2211e8165943192ad04f5dd21bedc29ff003e",
            "0",
            "0"
        ).send({
            value : 0,
            from : accounts[0],
            gasLimit : 2000000
        });

        let failed = false;
        try {
            await initialized.methods.transferTokens(
                TokenImplementation.address,
                new BigNumber(supply).minus(firstTransfer).toString(10),
                "10",
                "0x000000000000000000000000b7a2211e8165943192ad04f5dd21bedc29ff003e",
                "0",
                "0"
            ).send({
                value : 0,
                from : accounts[0],
                gasLimit : 2000000
            });
        } catch(error) {
            assert.equal(error.message, "Returned error: VM Exception while processing transaction: revert transfer exceeds max outstanding bridged token amount")
            failed = true
        }

        assert.ok(failed)
    })
});

const signAndEncodeVM = async function (
    timestamp,
    nonce,
    emitterChainId,
    emitterAddress,
    sequence,
    data,
    signers,
    guardianSetIndex,
    consistencyLevel
) {
    const body = [
        web3.eth.abi.encodeParameter("uint32", timestamp).substring(2 + (64 - 8)),
        web3.eth.abi.encodeParameter("uint32", nonce).substring(2 + (64 - 8)),
        web3.eth.abi.encodeParameter("uint16", emitterChainId).substring(2 + (64 - 4)),
        web3.eth.abi.encodeParameter("bytes32", emitterAddress).substring(2),
        web3.eth.abi.encodeParameter("uint64", sequence).substring(2 + (64 - 16)),
        web3.eth.abi.encodeParameter("uint8", consistencyLevel).substring(2 + (64 - 2)),
        data.substr(2)
    ]

    const hash = web3.utils.soliditySha3(web3.utils.soliditySha3("0x" + body.join("")))

    let signatures = "";

    for (let i in signers) {
        const ec = new elliptic.ec("secp256k1");
        const key = ec.keyFromPrivate(signers[i]);
        const signature = key.sign(hash.substr(2), {canonical: true});

        const packSig = [
            web3.eth.abi.encodeParameter("uint8", i).substring(2 + (64 - 2)),
            zeroPadBytes(signature.r.toString(16), 32),
            zeroPadBytes(signature.s.toString(16), 32),
            web3.eth.abi.encodeParameter("uint8", signature.recoveryParam).substr(2 + (64 - 2)),
        ]

        signatures += packSig.join("")
    }

    const vm = [
        web3.eth.abi.encodeParameter("uint8", 1).substring(2 + (64 - 2)),
        web3.eth.abi.encodeParameter("uint32", guardianSetIndex).substring(2 + (64 - 8)),
        web3.eth.abi.encodeParameter("uint8", signers.length).substring(2 + (64 - 2)),

        signatures,
        body.join("")
    ].join("");

    return vm
}

function zeroPadBytes(value, length) {
    while (value.length < 2 * length) {
        value = "0" + value;
    }
    return value;
}