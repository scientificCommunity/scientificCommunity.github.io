$(function(){
	$(document).bind("contextmenu", function () {
		return false;
	});//禁止右键
	document.oncontextmenu = function () {
		return false;
	};
	document.onkeydown = function () {
		if (window.event && window.event.keyCode == 123) {
			event.keyCode = 0;
			event.returnValue = false;
			return false;
		}
	};//禁止F12
});

function index(){
	var username=$("#username").val();
	var password=$("#password").val();
	var randcode=$("#randCode").val();
	var url = "http://localhost:8080/railway/loginTest";
	
	json = {username:username,password:password,randcode:randcode}
	jsonStr = JSON.stringify(json)
	$.ajax({
		type: "POST",
		url: url,
		data: jsonStr,
		dataType: "json",
		contentType:'application/json;charset=utf-8',
		success: function(returnData){
			alert(returnData);
			var rtnJson = JSON.parse(returnData);
			var status = rtnJson["status"];
			if(status=="1"){
				window.location="http://localhost:8080/railway12306/JSP/queryTickt.html";
			}
		},
		error: function(request, textStatus){
			alert("error");
			alert(url);
		}
	});
}

function refreshRand(){
//	var url = "http://localhost:8080/railway12306/wsr/getrandcode";
	$("#randImg").attr("src","http://localhost:8080/railway12306/wsr/getrandcode"+new Date());
}

function getrandcode(){
	var data2 = getXAndY(event);
    var x2 = data2.x;
    var y2 = data2.y;
    var y = y2 - 30;
    var yp=y-172;
    var xp = x2-12;
    
    var pointImg = '<img src="../Img/point.png" id="randImg" style="position:absolute;margin-left:'+xp+'px;margin-top:'+yp+'px;z-index:1;">';
    $("#randImgDiv").append(pointImg);
    var randCodeOldVal = $("#randCode").val();
    if(randCodeOldVal!=""){
    	randCodeOldVal+=","+x2+","+y;
    }else{
    	randCodeOldVal+=x2+","+y;
    }
    
    $("#randCode").val(randCodeOldVal);
    /*alert(x2+","+y);*/
    
}

//获取鼠标点击区域中的相对位置坐标
function getXAndY(event){
    //鼠标点击的绝对位置
    Ev= event || window.event;
    var mousePos = mouseCoords(event);
    var x = mousePos.x;
    var y = mousePos.y;
    //alert("鼠标点击的绝对位置坐标："+x+","+y);

    //获取div在body中的绝对位置
    var x1 = $("#randImgDiv").offset().left;
    var y1 = $("#randImgDiv").offset().top;
    //alert("div在body中的绝对位置坐标："+x1+","+y1);

    //鼠标点击位置相对于div的坐标
    var x2 = x - x1;
    var y2 = y - y1;
    return {x:x2,y:y2};
}

//获取鼠标点击区域在Html绝对位置坐标
function mouseCoords(event){
    if(event.pageX || event.pageY){
        return {x:event.pageX, y:event.pageY};
    }
    return{
        x:event.clientX + document.body.scrollLeft - document.body.clientLeft,
        y:event.clientY + document.body.scrollTop - document.body.clientTop
    };
}   